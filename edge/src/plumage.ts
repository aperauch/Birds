// Species photo / link integration.
//
// For a given species we surface (a) a Celebrate Urban Birds page link — shown
// next to the Wikipedia / eBird chips — and (b) a set of photos for an
// auto-scrolling carousel in the species modal.
//
// Photo source priority:
//   1. CUB "Plumage Photos" gallery (curated, age/sex-labelled) when the species
//      has a celebrateurbanbirds.org/birds/<slug>/ page.
//   2. All About Birds curated hero photos (also Cornell; labelled "Breeding
//      male" / "Female" / etc.) — exists for ~all North American species.
//   3. GBIF occurrence media (CC-licensed, iNaturalist-hosted only) as a final
//      fallback. GBIF doesn't rate-limit Cloudflare's shared egress IPs the way
//      iNaturalist's own API does.
//
// Results are cached in KV so each species' sources are fetched at most ~once per
// 30 days. Misses are cached (shorter TTL) and degrade to no link / no gallery.
import type { Bindings } from "./types";

const CACHE_PREFIX = "cub5:"; // bumped: curated AAB overrides
const HIT_TTL = 60 * 60 * 24 * 30; // 30d when we found something
const MISS_TTL = 60 * 60 * 24 * 7; // 7d before retrying an empty result
const MAX_PHOTOS = 12;
const UA = "birds.aperauch.com (personal bird monitor)";

export interface PlumagePhoto {
  url: string; // mid-size image (hotlinked; sources allow it)
  label: string; // e.g. "Adult", "Adult (White-browed)"; "" for iNaturalist
  credit: string; // e.g. "© Don Danko / Macaulay Library"
}

export interface CubInfo {
  url: string | null; // canonical CUB page URL, or null if the species has none
  photos: PlumagePhoto[];
  // "cub"/"aab" = curated plumage photos; "obs" = GBIF observation photos
  source: "cub" | "aab" | "obs" | null;
}

/** Slug used by celebrateurbanbirds.org, e.g. "Carolina Wren" -> "carolina-wren". */
export function cubSlug(comName: string): string {
  return comName
    .toLowerCase()
    .replace(/['\u2019]/g, "") // drop apostrophes (Cooper's -> coopers)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function getCubInfo(env: Bindings, sci: string, comName: string): Promise<CubInfo> {
  const key = CACHE_PREFIX + sci.toLowerCase();
  const cached = await env.CACHE.get<CubInfo>(key, "json");
  if (cached) return cached;

  let url: string | null = null;
  let photos: PlumagePhoto[] = [];
  let source: CubInfo["source"] = null;
  let errored = false;

  // 1) Celebrate Urban Birds (page link + curated plumage gallery).
  try {
    const cub = await scrapeCub(comName);
    url = cub.url;
    photos = cub.photos;
    if (photos.length) source = "cub";
  } catch (e) {
    console.error("cub: scrape failed for", comName, e);
    errored = true;
  }

  // 2) Curated All About Birds override takes priority for photos when present
  //    (authoritative, correctly-labelled plumages for species we've vetted).
  const override = aabOverride(sci);
  if (override.length) {
    photos = override;
    source = "aab";
  }

  // 3) GBIF observation photos (iNaturalist-hosted) as a last resort.
  if (photos.length === 0) {
    try {
      const obs = await gbifPhotos(sci);
      if (obs.length) {
        photos = obs;
        source = "obs";
      }
    } catch (e) {
      console.error("gbif: fetch failed for", sci, e);
      errored = true;
    }
  }

  const info: CubInfo = { url, photos, source };
  // Cache real results; skip caching a transient all-sources-failed empty.
  if (!(errored && !url && photos.length === 0)) {
    await env.CACHE.put(key, JSON.stringify(info), {
      expirationTtl: url || photos.length ? HIT_TTL : MISS_TTL,
    });
  }
  return info;
}

async function scrapeCub(comName: string): Promise<{ url: string | null; photos: PlumagePhoto[] }> {
  const slug = cubSlug(comName);
  const res = await fetch(`https://celebrateurbanbirds.org/birds/${slug}/`, {
    headers: { "User-Agent": UA },
    cf: { cacheTtl: 86400, cacheEverything: true },
    redirect: "follow", // focal species 301 to /birds/focal-species/<slug>/
  });
  if (!res.ok) return { url: null, photos: [] };
  const html = await res.text();
  return { url: res.url, photos: parsePlumage(html) };
}

// --- All About Birds curated overrides ---------------------------------------
//
// allaboutbirds.org blocks automated access (403 to Worker fetches; bot-challenges
// Browser Rendering), so its curated hero photos can't be scraped server-side.
// The images themselves DO hotlink from the browser, so for species we've vetted
// we pin their Macaulay asset IDs (read from the /guide/<Name>/overview page) and
// build the (browser-loadable) image URLs directly. Add species here as needed.
const AAB_OVERRIDES: Record<string, Array<{ id: string; label: string }>> = {
  // Scarlet Tanager — https://www.allaboutbirds.org/guide/Scarlet_Tanager/overview
  "piranga olivacea": [
    { id: "297081931", label: "Breeding male" },
    { id: "297082251", label: "Female" },
  ],
};

function aabOverride(sci: string): PlumagePhoto[] {
  const entries = AAB_OVERRIDES[sci.trim().toLowerCase()];
  if (!entries) return [];
  return entries.map((e) => ({
    url: `https://www.allaboutbirds.org/guide/assets/photo/${e.id}-720px.jpg`,
    label: e.label,
    credit: "Macaulay Library \u00b7 All About Birds",
  }));
}

// --- GBIF observation-photo fallback -----------------------------------------

interface GbifMedia {
  type?: string;
  identifier?: string;
  license?: string;
  creator?: string;
  rightsHolder?: string;
}

async function gbifJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`gbif ${res.status}`);
  return (await res.json()) as T;
}

async function gbifPhotos(sci: string): Promise<PlumagePhoto[]> {
  const match = await gbifJson<{ usageKey?: number }>(
    `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(sci)}`,
  );
  const key = match.usageKey;
  if (!key) return [];
  const data = await gbifJson<{ results?: Array<{ media?: GbifMedia[] }> }>(
    `https://api.gbif.org/v1/occurrence/search?taxonKey=${key}&mediaType=StillImage&limit=40`,
  );
  const out: PlumagePhoto[] = [];
  const seen = new Set<string>();
  for (const occ of data.results ?? []) {
    for (const m of occ.media ?? []) {
      if (m.type !== "StillImage" || !m.identifier) continue;
      const lic = ccLabel(m.license);
      if (!lic) continue; // CC / public-domain only
      let url = m.identifier.replace(/^http:/, "https:");
      // Accept iNaturalist-hosted photos only. GBIF also returns xeno-canto sound
      // spectrogram PNGs as "StillImage"; restricting the host excludes those.
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      if (!host.includes("inaturalist")) continue;
      // Use a mid-size variant of iNaturalist originals.
      url = url.replace(/\/original\.(jpe?g|png)(\?.*)?$/i, "/medium.$1");
      if (seen.has(url)) continue;
      seen.add(url);
      const who = (m.rightsHolder || m.creator || "").replace(/\s+/g, " ").trim();
      out.push({ url, label: "", credit: `\u00a9 ${who || "Unknown"} (${lic}) \u00b7 iNaturalist` });
      break; // one photo per occurrence
    }
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

/** Short label for a Creative Commons / public-domain license URL, else null. */
function ccLabel(license?: string): string | null {
  if (!license) return null;
  const u = license.toLowerCase();
  if (u.includes("publicdomain") || u.includes("/zero/") || u.includes("cc0")) return "CC0";
  const m = u.match(/licenses\/([a-z-]+)\//);
  return m?.[1] ? "CC " + m[1].toUpperCase() : null;
}

function parsePlumage(html: string): PlumagePhoto[] {
  const start = html.indexOf("Plumage Photos");
  if (start === -1) return [];
  const rest = html.slice(start + "Plumage Photos".length);
  // Bound the section to the next heading (the gallery is followed by e.g.
  // "Similar Species") so we never bleed into unrelated images.
  const nextH = rest.search(/<h[1-4][\s>]/i);
  const section = nextH === -1 ? rest : rest.slice(0, nextH);

  const photos: PlumagePhoto[] = [];
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(section)) !== null && photos.length < MAX_PHOTOS) {
    const tag = m[0];
    const url = pickUrl(tag);
    if (!url) continue;
    // The <figcaption> follows the <img> within the same <figure>.
    const after = section.slice(m.index + tag.length, m.index + tag.length + 400);
    const capHtml = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(after)?.[1] ?? "";
    const { label, credit } = splitCaption(capHtml);
    photos.push({ url, label, credit });
  }
  return photos;
}

function pickUrl(imgTag: string): string | null {
  const srcset = /data-srcset="([^"]+)"/i.exec(imgTag)?.[1];
  if (srcset) {
    const entries = srcset.split(",").map((s) => s.trim());
    for (const w of ["720w", "768w", "480w"]) {
      const hit = entries.find((e) => e.endsWith(" " + w));
      if (hit) return normalize(hit.split(/\s+/)[0] ?? "");
    }
    const first = entries[0]?.split(/\s+/)[0];
    if (first) return normalize(first);
  }
  const dataSrc = /data-src="([^"]+)"/i.exec(imgTag)?.[1];
  return dataSrc ? normalize(dataSrc) : null;
}

function normalize(u: string): string {
  // CUB emits a stray double slash on some data-src values.
  return u.replace("org//wp-content", "org/wp-content");
}

function splitCaption(raw: string): { label: string; credit: string } {
  const text = decode(raw.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
  const i = text.indexOf("\u00a9"); // ©
  if (i === -1) return { label: text.replace(/\s+/g, " ").trim(), credit: "" };
  return {
    label: text.slice(0, i).replace(/\s+/g, " ").trim(),
    credit: text.slice(i).replace(/\s+/g, " ").trim(),
  };
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#8211;/g, "\u2013")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
