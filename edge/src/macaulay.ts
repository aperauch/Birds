// eBird / Macaulay Library photos — the app's highest-priority photo source.
//
// eBird (ebird.org) surfaces the best, expertly-reviewed bird photos via the
// Cornell Lab's Macaulay Library, so we prefer them on both the collage tiles
// and the species-modal carousel.
//
// Access reality (verified June 2026):
//   • The Macaulay *search* API (search.macaulaylibrary.org / media.ebird.org
//     /api/v2/search) is bot-protected — 403 to plain `fetch()` even with full
//     browser headers + a cookie handshake — and ebird.org/species/<code> pages
//     now require login. So a species' photo asset ids CANNOT be discovered from
//     a Worker.
//   • The Macaulay *asset image CDN* (cdn.download.ams.birds.cornell.edu/
//     api/v1/asset/<id>[/<size>]) is open (AWS CloudFront) — any known asset id
//     hotlinks. The bare URL returns a small default; append a size
//     (320/480/640/900/1200/1800/2400) for a specific resolution.
//
// Discovery therefore happens OUT OF BAND: tools/macaulay_scraper drives a real
// Chromium (Playwright, stealth) that runs the JS bot-challenge, scrapes each
// species' top asset ids + photographer credits, and POSTs them to this Worker's
// `POST /admin/macaulay` endpoint (-> ingestMacaulay). We persist the ids in KV
// (read by the species modal) and re-host the top photo in R2 as the collage
// tile. The Worker only ever READS the open asset CDN (to mirror one photo into
// R2); it never tries to reach the bot-blocked search API.
import type { Bindings } from "./types";
import { keys } from "./media";

const UA = "birds.aperauch.com (personal bird monitor)";
const CACHE_PREFIX = "macaulay:v1:";
const HIT_TTL = 60 * 60 * 24 * 30; // 30d once we have photos
const MISS_TTL = 60 * 60 * 24 * 3; // 3d for an empty result (re-scrape sooner)
const MAX_PHOTOS = 12;
// Mid-size asset-CDN variant. The v1 path serves a bare default and any of
// 320/480/640/900/1200/1800/2400; we pin 1200 for crisp display.
const ASSET_SIZE = 1200;

export interface MacaulayPhoto {
  assetId: string;
  url: string; // hotlinkable asset-CDN image
  label: string; // age/sex when the catalog exposes it; usually ""
  credit: string; // "© <photographer> / Macaulay Library"
}

/** Public asset-CDN image URL for a Macaulay asset id (AWS CloudFront, v1). */
export function assetImageUrl(assetId: string | number, size: number = ASSET_SIZE): string {
  return `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${assetId}/${size}`;
}

interface Cached {
  photos: MacaulayPhoto[];
}

/**
 * KV-cached photos for an eBird code. Returns null when the code has never been
 * ingested (so callers fall back to other sources) versus [] when it was
 * ingested but the species has no eBird photos.
 */
export async function getCachedMacaulay(
  env: Bindings,
  code: string,
): Promise<MacaulayPhoto[] | null> {
  const hit = await env.CACHE.get<Cached>(CACHE_PREFIX + code.toLowerCase(), "json");
  return hit ? hit.photos : null;
}

// Raw photo as sent by the scraper. We trust only the asset id + free-text
// label/credit; the image URL is always rebuilt server-side from the id.
export interface RawMacaulayPhoto {
  assetId: string | number;
  label?: string;
  credit?: string;
}

export interface MacaulayIngest {
  code: string;
  sci_name?: string;
  photos: RawMacaulayPhoto[];
  update_collage?: boolean;
}

function normalizePhotos(raw: RawMacaulayPhoto[], max: number = MAX_PHOTOS): MacaulayPhoto[] {
  const out: MacaulayPhoto[] = [];
  const seen = new Set<string>();
  for (const r of raw ?? []) {
    const assetId = String(r?.assetId ?? "").trim();
    if (!/^\d+$/.test(assetId) || seen.has(assetId)) continue;
    seen.add(assetId);
    const label = String(r?.label ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const credit =
      String(r?.credit ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160) || "\u00a9 Macaulay Library";
    out.push({ assetId, url: assetImageUrl(assetId), label, credit });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Store scraped Macaulay photos for an eBird code: persist the ids in KV and,
 * when a scientific name is given, mirror the top photo into R2 as the species'
 * collage tile (overwriting the Wikipedia fallback) and point species.photo_key
 * at it. Called by the authenticated POST /admin/macaulay endpoint.
 */
export async function ingestMacaulay(
  env: Bindings,
  body: MacaulayIngest,
): Promise<{ code: string; stored: number; collage_key: string | null }> {
  const code = String(body?.code ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9]+$/.test(code)) throw new Error("invalid eBird code");

  const photos = normalizePhotos(body?.photos ?? []);
  await env.CACHE.put(CACHE_PREFIX + code, JSON.stringify({ photos } as Cached), {
    expirationTtl: photos.length ? HIT_TTL : MISS_TTL,
  });

  let collageKey: string | null = null;
  if (body?.update_collage !== false && body?.sci_name && photos.length) {
    collageKey = await storeCollagePhoto(env, body.sci_name, photos);
    if (collageKey) {
      await env.DB.prepare(
        "UPDATE species SET photo_key = ?, updated_at = unixepoch() WHERE sci_name = ?",
      )
        .bind(collageKey, body.sci_name)
        .run();
    }
  }
  return { code, stored: photos.length, collage_key: collageKey };
}

/**
 * Mirror the top Macaulay photo into R2 as the species' collage photo and record
 * provenance in art_assets. Returns the R2 key, or null if nothing could be
 * stored. Uses the same key as the Wikipedia photo (keys.speciesPhoto) so the
 * collage's existing `photo_url` plumbing is unchanged.
 */
export async function storeCollagePhoto(
  env: Bindings,
  sci: string,
  photos: MacaulayPhoto[],
): Promise<string | null> {
  const top = photos[0];
  if (!top) return null;
  const img = await fetch(top.url, { headers: { "User-Agent": UA } });
  if (!img.ok || !img.body) return null;
  const key = keys.speciesPhoto(sci);
  await env.MEDIA.put(key, img.body, {
    httpMetadata: { contentType: img.headers.get("content-type") ?? "image/jpeg" },
  });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO art_assets (id, scope, ref_id, kind, variant, r2_key, status, model, meta)
     VALUES (?, 'species', ?, 'photo', NULL, ?, 'done', 'macaulay', ?)`,
  )
    .bind(
      `${sci}:photo`,
      sci,
      key,
      JSON.stringify({ assetId: top.assetId, credit: top.credit, source: top.url }),
    )
    .run();
  return key;
}
