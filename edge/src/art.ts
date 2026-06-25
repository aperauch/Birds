// Art queue consumer.
//
// For each NEW species:
//   1. resolve its eBird code, then fetch the best photo — eBird/Macaulay
//      first (highest quality), falling back to Wikipedia — for the collage tile
//   2. generate FLUX.2 signature-style illustrations (perched + flight)
// For each detection WITH a spectrogram:
//   3. SDXL img2img stylization of the spectrogram -> one-of-a-kind artwork
import type { ArtJob, Bindings } from "./types";
import { keys } from "./media";
import { cutoutCream } from "./cutout";
import { resolveEbirdCode } from "./ebird";
import { getCachedMacaulay, storeCollagePhoto } from "./macaulay";

const FLUX_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";
const IMG2IMG_MODEL = "@cf/runwayml/stable-diffusion-v1-5-img2img";

// --- signature style --------------------------------------------------------
// A consistent house style so every species reads as one cohesive collection,
// on a warm cream ground that blends into the site.
const STYLE =
  "vintage natural-history field-guide illustration, hand-painted gouache and " +
  "ink, soft matte risograph texture, limited earthy palette of burnt sienna, " +
  "ochre, sage green, slate blue and ivory, gentle duotone shading, fine " +
  "confident linework, scientifically accurate plumage, a single centered " +
  "full-body bird on a plain warm cream paper ground, no text, no caption, " +
  "no border, no frame, no human, no hands";

const NEGATIVE =
  "text, watermark, signature, caption, frame, border, multiple birds, " +
  "extra wings, extra legs, deformed, blurry, photographic, 3d render";

function buildPrompt(com: string, sci: string, pose: "perched" | "flight"): string {
  const posture =
    pose === "flight"
      ? "in flight, both wings fully extended, dynamic side profile"
      : "perched, calm side profile, wings folded, implied perch (no branch drawn)";
  return `A ${com} (${sci}), ${posture}. ${STYLE}.`;
}

// --- Workers AI helpers -----------------------------------------------------
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function fluxImage(env: Bindings, prompt: string): Promise<Uint8Array> {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "1024");
  form.append("steps", "8");
  // FormData -> stream + boundary content-type (required by the multipart input).
  const fr = new Response(form);
  const resp = (await (env.AI as unknown as {
    run: (m: string, i: unknown) => Promise<{ image?: string }>;
  }).run(FLUX_MODEL, {
    multipart: { body: fr.body, contentType: fr.headers.get("content-type") },
  })) as { image?: string };
  if (!resp.image) throw new Error("flux: no image in response");
  return b64ToBytes(resp.image);
}

async function img2img(
  env: Bindings,
  inputPng: Uint8Array,
  prompt: string,
): Promise<ReadableStream> {
  // image_b64 (string) is more reliable over the binding than a number[] array.
  const resp = await (env.AI as unknown as {
    run: (m: string, i: unknown) => Promise<ReadableStream>;
  }).run(IMG2IMG_MODEL, {
    prompt,
    image_b64: bytesToB64(inputPng),
    negative_prompt: NEGATIVE,
    strength: 0.8, // transform the spectrogram into art while echoing its structure
    guidance: 7.5,
    num_steps: 20,
  });
  return resp;
}

// --- jobs -------------------------------------------------------------------
interface WikiSummary {
  extract?: string;
  thumbnail?: { source: string };
  originalimage?: { source: string };
  content_urls?: { desktop?: { page?: string } };
}

async function fetchWikiSummary(term: string): Promise<WikiSummary | null> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.replace(/ /g, "_"))}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "birds.aperauch.com (personal bird monitor)" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) return null;
  return (await res.json()) as WikiSummary;
}

// Resolve a width-bounded Wikipedia image. We derive the canonical Wikimedia
// file name from the summary's thumbnail/original URL and request a sized
// rendition via Special:FilePath, which reliably returns a width-bounded image
// (~100-300 KB) and lets serve-time Image Transformations downscale per layout.
// NOTE: the older "/<N>px-" thumbnail rewrite returns HTTP 400 for many files
// (large originals, names with parentheses, etc.), which silently left species
// without a collage photo — Special:FilePath avoids that failure mode.
function wikiImageUrl(summary: WikiSummary): string | null {
  const src = summary.thumbnail?.source ?? summary.originalimage?.source;
  if (!src) return null;
  let file: string | null;
  if (src.includes("/thumb/")) {
    // .../commons/thumb/x/xx/<FILE>/<width>px-<FILE>
    const parts = src.split("/thumb/")[1]?.split("/");
    file = parts && parts.length >= 3 ? (parts[2] ?? null) : null;
  } else {
    // .../commons/x/xx/<FILE>
    file = src.split("/").pop() ?? null;
  }
  if (!file) return null;
  // `file` is already percent-encoded in the source URL path; Special:FilePath
  // accepts the encoded name directly.
  return `https://en.wikipedia.org/wiki/Special:FilePath/${file}?width=1024`;
}

async function recordArt(
  env: Bindings,
  id: string,
  refId: string,
  kind: string,
  variant: string | null,
  key: string,
  model: string,
  meta: object,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO art_assets (id, scope, ref_id, kind, variant, r2_key, status, model, meta)
     VALUES (?, 'species', ?, ?, ?, ?, 'done', ?, ?)`,
  )
    .bind(id, refId, kind, variant, key, model, JSON.stringify(meta))
    .run();
}

const WIKI_UA = "birds.aperauch.com (personal bird monitor)";

/**
 * eBird/Macaulay collage photo from the KV-cached asset ids. eBird is the
 * preferred source, but its asset ids can only be discovered out of band by the
 * Playwright scraper (POST /admin/macaulay) — the search API is bot-blocked from
 * a Worker — so this only yields a photo once the species' code has been
 * scraped. Returns the R2 key, or null.
 */
async function ebirdCollagePhoto(
  env: Bindings,
  sci: string,
  ebirdCode: string | null,
): Promise<string | null> {
  if (!ebirdCode) return null;
  try {
    const cached = await getCachedMacaulay(env, ebirdCode);
    if (cached && cached.length) return await storeCollagePhoto(env, sci, cached);
  } catch (e) {
    console.error("macaulay: collage photo failed for", sci, e);
  }
  return null;
}

/** Mirror a Wikipedia reference photo (from a fetched summary) into R2. */
async function storeWikiPhoto(
  env: Bindings,
  sci: string,
  summary: WikiSummary,
): Promise<string | null> {
  const imgSrc = wikiImageUrl(summary);
  if (!imgSrc) return null;
  const img = await fetch(imgSrc, { headers: { "User-Agent": WIKI_UA } });
  if (!img.ok || !img.body) return null;
  const key = keys.speciesPhoto(sci);
  await env.MEDIA.put(key, img.body, {
    httpMetadata: { contentType: img.headers.get("content-type") ?? "image/jpeg" },
  });
  await recordArt(env, `${sci}:photo`, sci, "photo", null, key, "wikimedia", { source: imgSrc });
  return key;
}

/**
 * Resolve a collage photo for a species: eBird/Macaulay (preferred, when its
 * asset ids have been scraped into KV) then a Wikipedia reference photo. Returns
 * the R2 key, or null if neither source yielded an image. Shared by the art job
 * (first sighting) and the /admin/backfill-photos self-heal.
 */
export async function resolveSpeciesPhoto(
  env: Bindings,
  sci: string,
  com: string,
  ebirdCode: string | null,
): Promise<string | null> {
  const ebird = await ebirdCollagePhoto(env, sci, ebirdCode);
  if (ebird) return ebird;
  const summary = (await fetchWikiSummary(com)) ?? (await fetchWikiSummary(sci));
  return summary ? await storeWikiPhoto(env, sci, summary) : null;
}

/**
 * Backfill collage photos for species missing one (photo_key IS NULL) so a
 * missed first-sighting photo self-heals instead of showing the AI illustration
 * forever. eBird photos still arrive via the scraper (POST /admin/macaulay);
 * this is the automatic Wikipedia safety net.
 */
export async function backfillSpeciesPhotos(
  env: Bindings,
  limit = 50,
): Promise<{
  scanned: number;
  fixed: number;
  results: Array<{ sci_name: string; photo_key: string | null }>;
}> {
  const { results: rows } = await env.DB.prepare(
    "SELECT sci_name, com_name, ebird_code FROM species WHERE photo_key IS NULL LIMIT ?",
  )
    .bind(limit)
    .all<{ sci_name: string; com_name: string; ebird_code: string | null }>();
  const results: Array<{ sci_name: string; photo_key: string | null }> = [];
  let fixed = 0;
  for (const r of rows ?? []) {
    let key: string | null = null;
    try {
      key = await resolveSpeciesPhoto(env, r.sci_name, r.com_name, r.ebird_code);
    } catch (e) {
      console.error("backfill photo failed for", r.sci_name, e);
    }
    if (key) {
      await env.DB.prepare(
        "UPDATE species SET photo_key = ?, updated_at = unixepoch() WHERE sci_name = ?",
      )
        .bind(key, r.sci_name)
        .run();
      fixed++;
    }
    results.push({ sci_name: r.sci_name, photo_key: key });
  }
  return { scanned: rows?.length ?? 0, fixed, results };
}

async function handleSpeciesJob(
  env: Bindings,
  job: Extract<ArtJob, { kind: "species" }>,
): Promise<void> {
  // 0) eBird species code (authoritative, keyless) for canonical /species/<code>
  //    links and Macaulay photo lookup.
  const ebirdCode = await resolveEbirdCode(env, job.sci_name, job.com_name);

  // 1) PHOTO for the collage tile. Prefer eBird/Macaulay (best, expertly-
  //    reviewed); fall back to a Wikipedia reference photo. eBird photos are
  //    discovered out of band by the Playwright scraper (POST /admin/macaulay)
  //    and cached in KV — so here we can only reuse them if this species' code
  //    has already been scraped (e.g. seen before under another name). Both
  //    sources land at the same R2 key, so the collage `photo_url` is unchanged.
  // 1a) eBird/Macaulay collage photo (preferred) when its asset ids have already
  //     been scraped into KV out of band.
  let photoKey: string | null = await ebirdCollagePhoto(env, job.sci_name, ebirdCode);

  // 1b) Wikipedia summary still supplies the wiki link, and the reference photo
  //     when eBird has none yet.
  const summary =
    (await fetchWikiSummary(job.com_name)) ?? (await fetchWikiSummary(job.sci_name));
  const wikiUrl: string | null = summary?.content_urls?.desktop?.page ?? null;
  if (!photoKey && summary) {
    photoKey = await storeWikiPhoto(env, job.sci_name, summary);
  }

  // 2) FLUX signature-style illustrations (perched + flight). Best-effort each.
  //    For each pose we also chroma-key the cream ground to a transparent cutout.
  let perchedKey: string | null = null;
  let flightKey: string | null = null;
  let perchedCutKey: string | null = null;
  let flightCutKey: string | null = null;
  for (const pose of ["perched", "flight"] as const) {
    try {
      const bytes = await fluxImage(env, buildPrompt(job.com_name, job.sci_name, pose));
      const key = keys.speciesFlux(job.sci_name, pose);
      await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
      if (pose === "perched") perchedKey = key;
      else flightKey = key;
      await recordArt(env, `${job.sci_name}:flux-${pose}`, job.sci_name, "flux", pose, key, FLUX_MODEL, {
        prompt_style: "field-guide-gouache-v1",
      });

      // Background cutout + silhouette mask (best-effort; failures keep the
      // rectangular FLUX tile working).
      try {
        const cut = cutoutCream(bytes);
        const cutKey = keys.speciesFluxCut(job.sci_name, pose);
        await env.MEDIA.put(cutKey, cut.png, { httpMetadata: { contentType: "image/png" } });
        if (pose === "perched") perchedCutKey = cutKey;
        else flightCutKey = cutKey;
        await recordArt(
          env,
          `${job.sci_name}:flux-${pose}-cut`,
          job.sci_name,
          "flux_cut",
          pose,
          cutKey,
          "photon-chroma-key",
          { from: key },
        );
      } catch (e) {
        console.error(`cutout ${pose} failed for ${job.sci_name}:`, e);
      }
    } catch (e) {
      console.error(`flux ${pose} failed for ${job.sci_name}:`, e);
    }
  }

  await env.DB.prepare(
    `UPDATE species
        SET photo_key            = COALESCE(?, photo_key),
            wikipedia_url        = COALESCE(?, wikipedia_url),
            ebird_code           = COALESCE(?, ebird_code),
            flux_perched_key     = COALESCE(?, flux_perched_key),
            flux_flight_key      = COALESCE(?, flux_flight_key),
            flux_perched_cut_key = COALESCE(?, flux_perched_cut_key),
            flux_flight_cut_key  = COALESCE(?, flux_flight_cut_key),
            updated_at           = unixepoch()
      WHERE sci_name = ?`,
  )
    .bind(
      photoKey,
      wikiUrl,
      ebirdCode,
      perchedKey,
      flightKey,
      perchedCutKey,
      flightCutKey,
      job.sci_name,
    )
    .run();
}

async function handleImg2ImgJob(
  env: Bindings,
  job: Extract<ArtJob, { kind: "img2img" }>,
): Promise<void> {
  const obj = await env.MEDIA.get(job.spectrogram_key);
  if (!obj) {
    await env.DB.prepare("UPDATE detections SET art_status = 'skipped' WHERE id = ?")
      .bind(job.detection_id)
      .run();
    return;
  }
  const input = new Uint8Array(await obj.arrayBuffer());
  const prompt =
    `An abstract impressionist artwork evoking the song of a ${job.com_name}, ` +
    `flowing organic forms, warm earthy gouache palette, soft matte texture, ` +
    `painterly, no text`;
  const out = await img2img(env, input, prompt);
  const key = keys.detectionArt(job.detection_id);
  await env.MEDIA.put(key, out, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare(
    "UPDATE detections SET art_status = 'done', art_key = ? WHERE id = ?",
  )
    .bind(key, job.detection_id)
    .run();
}

export async function handleArtBatch(
  batch: MessageBatch<ArtJob>,
  env: Bindings,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      if (msg.body.kind === "species") {
        await handleSpeciesJob(env, msg.body);
      } else {
        await handleImg2ImgJob(env, msg.body);
      }
      msg.ack();
    } catch (err) {
      console.error("art job failed", msg.body, err);
      msg.retry();
    }
  }
}
