// Ingest: the single authenticated entrypoint the Raspberry Pi forwarder hits.
//
// Accepts multipart/form-data:
//   meta        (JSON, required)  -> IngestMeta
//   clip        (file, optional)  -> mp3 extraction
//   spectrogram (file, optional)  -> spectrogram PNG
import type { Context } from "hono";
import type { ArtJob, Bindings, DetectionEvent, IngestMeta } from "./types";
import { bumpDailyStats, insertDetection, isRareSpecies, upsertSpecies } from "./db";
import { keys, mediaUrl } from "./media";
import { notifyDetection } from "./notify";

function parseMeta(raw: unknown): IngestMeta {
  if (typeof raw !== "string") throw new Error("meta missing");
  const m = JSON.parse(raw) as Partial<IngestMeta>;
  if (!m.id || !m.sci_name || !m.com_name || typeof m.confidence !== "number" || typeof m.ts !== "number") {
    throw new Error("meta missing required fields (id, ts, sci_name, com_name, confidence)");
  }
  return m as IngestMeta;
}

export async function handleIngest(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  // Constant-time-ish bearer check.
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!c.env.INGEST_TOKEN || token !== c.env.INGEST_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }

  let meta: IngestMeta;
  try {
    meta = parseMeta(form.get("meta"));
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }

  const clip = form.get("clip");
  const spectrogram = form.get("spectrogram");

  // Store media in R2 (best-effort; a detection without a clip is still valid).
  let clipKey: string | null = null;
  let spectrogramKey: string | null = null;

  if (clip instanceof File && clip.size > 0) {
    clipKey = keys.clip(meta.ts, meta.id);
    await c.env.MEDIA.put(clipKey, clip.stream(), {
      httpMetadata: { contentType: "audio/mpeg" },
    });
  }
  if (spectrogram instanceof File && spectrogram.size > 0) {
    spectrogramKey = keys.spectrogram(meta.ts, meta.id);
    await c.env.MEDIA.put(spectrogramKey, spectrogram.stream(), {
      httpMetadata: { contentType: "image/png" },
    });
  }

  // Persist to D1.
  const { isNewSpecies } = await upsertSpecies(c.env.DB, meta);
  const inserted = await insertDetection(c.env.DB, meta, clipKey, spectrogramKey);
  // Maintain the daily rollup only on a genuine insert (idempotent re-sends
  // must not double-count).
  if (inserted) await bumpDailyStats(c.env.DB, meta);
  const rareDays = Number(c.env.RARE_SPECIES_DAYS || "30");
  const isRare = isNewSpecies || (await isRareSpecies(c.env.DB, meta.sci_name, meta.ts, rareDays));

  // Build the live event and broadcast via the Aviary DO.
  const event: DetectionEvent = {
    id: meta.id,
    ts: meta.ts,
    sci_name: meta.sci_name,
    com_name: meta.com_name,
    confidence: meta.confidence,
    clip_url: mediaUrl(c.env, clipKey),
    spectrogram_url: mediaUrl(c.env, spectrogramKey),
    is_new_species: isNewSpecies,
    is_rare: isRare,
  };
  const aviary = c.env.AVIARY.get(c.env.AVIARY.idFromName("global"));
  c.executionCtx.waitUntil(aviary.broadcast(event));

  // Notify on new/rare species (throttled per species). Only on a genuine
  // insert so idempotent re-sends never re-alert.
  if (inserted && (isNewSpecies || isRare)) {
    c.executionCtx.waitUntil(notifyDetection(c.env, event));
  }

  // Enqueue art generation (species art on first sighting; img2img per clip).
  const jobs: ArtJob[] = [];
  if (isNewSpecies) {
    jobs.push({ kind: "species", sci_name: meta.sci_name, com_name: meta.com_name });
  }
  if (spectrogramKey) {
    jobs.push({
      kind: "img2img",
      detection_id: meta.id,
      spectrogram_key: spectrogramKey,
      sci_name: meta.sci_name,
      com_name: meta.com_name,
    });
  }
  if (jobs.length) {
    c.executionCtx.waitUntil(
      Promise.all(jobs.map((j) => c.env.ART_QUEUE.send(j))).then(() => undefined),
    );
  }

  return c.json({ ok: true, id: meta.id, new_species: isNewSpecies, rare: isRare });
}
