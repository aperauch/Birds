// Resolve a scientific name to its eBird species code (e.g. "amerob") so the
// dashboard can link to https://ebird.org/species/<code> AND look up the
// species' Macaulay Library photos (see macaulay.ts).
//
// Primary resolver: the eBird taxonomy API, which is keyless and authoritative.
//   https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&cat=species
// We download the species taxonomy once (~3.5 MB), cache it in KV, and build a
// name -> code index. Matching is forgiving so a BirdNET name that doesn't match
// eBird exactly still resolves:
//   1. exact scientific name
//   2. binomial (drops a subspecies trinomial, e.g. "Setophaga coronata coronata")
//   3. common name
// Wikidata (P225 "taxon name" -> P3444 "eBird taxon ID") is a last-resort
// fallback for names absent from the eBird taxonomy. Per-species results
// (including misses) are cached in KV so each species is resolved at most once.
import type { Bindings } from "./types";

const CACHE_PREFIX = "ebird:";
const HIT_TTL = 60 * 60 * 24 * 90; // 90d once resolved (codes are stable)
const MISS_TTL = 60 * 60 * 24 * 7; // 7d before retrying a species with no code

const TAXONOMY_KEY = "ebird:taxonomy:v1";
const TAXONOMY_TTL = 60 * 60 * 24 * 30; // refresh the cached taxonomy monthly
const UA = "birds.aperauch.com (personal bird monitor)";

export function ebirdUrl(code: string | null | undefined): string | null {
  return code ? `https://ebird.org/species/${code}` : null;
}

/**
 * Returns the eBird species code for `sciName`, or null if none is known.
 * `comName` (when available) enables a common-name fallback match.
 * Cached in KV; transient network errors are not cached (so they retry later).
 */
export async function resolveEbirdCode(
  env: Bindings,
  sciName: string,
  comName?: string,
): Promise<string | null> {
  const key = CACHE_PREFIX + sciName.trim().toLowerCase();
  const cached = await env.CACHE.get(key);
  if (cached !== null) return cached === "" ? null : cached; // "" is a cached miss

  let code: string | null = null;
  let transient = false;

  // 1) Authoritative eBird taxonomy (keyless).
  try {
    code = await resolveViaTaxonomy(env, sciName, comName);
  } catch (e) {
    console.error("ebird: taxonomy resolve failed for", sciName, e);
    transient = true;
  }

  // 2) Wikidata fallback for names missing from the eBird taxonomy.
  if (!code) {
    try {
      code = await queryWikidata(sciName);
    } catch (e) {
      console.error("ebird: wikidata resolve failed for", sciName, e);
      transient = true;
    }
  }

  // Don't cache a transient all-sources-failed result, so a later request retries.
  if (code || !transient) {
    await env.CACHE.put(key, code ?? "", { expirationTtl: code ? HIT_TTL : MISS_TTL });
  }
  return code;
}

// --- eBird taxonomy index ----------------------------------------------------

interface TaxonRow {
  sciName?: string;
  comName?: string;
  speciesCode?: string;
}

// Memoised per-isolate so we parse the (large) taxonomy at most once per isolate.
let taxonomyIndex: Map<string, string> | null = null;

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function loadTaxonomyIndex(env: Bindings): Promise<Map<string, string>> {
  if (taxonomyIndex) return taxonomyIndex;

  let rows = await env.CACHE.get<TaxonRow[]>(TAXONOMY_KEY, "json");
  if (!rows) {
    const res = await fetch(
      "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&cat=species",
      { headers: { Accept: "application/json", "User-Agent": UA } },
    );
    if (!res.ok) throw new Error(`ebird taxonomy ${res.status}`);
    rows = (await res.json()) as TaxonRow[];
    // Cache the raw taxonomy (well under KV's 25 MB value limit).
    await env.CACHE.put(TAXONOMY_KEY, JSON.stringify(rows), { expirationTtl: TAXONOMY_TTL });
  }

  const index = new Map<string, string>();
  for (const r of rows) {
    if (!r.speciesCode) continue;
    if (r.sciName) index.set(norm(r.sciName), r.speciesCode);
    // Prefix common-name keys so they can't collide with a scientific name.
    if (r.comName) index.set("c:" + norm(r.comName), r.speciesCode);
  }
  taxonomyIndex = index;
  return index;
}

async function resolveViaTaxonomy(
  env: Bindings,
  sciName: string,
  comName?: string,
): Promise<string | null> {
  const index = await loadTaxonomyIndex(env);

  const sci = norm(sciName);
  const exact = index.get(sci);
  if (exact) return exact;

  // Subspecies trinomial -> binomial (e.g. "Junco hyemalis hyemalis").
  const parts = sci.split(" ");
  if (parts.length > 2) {
    const binomial = parts.slice(0, 2).join(" ");
    const hit = index.get(binomial);
    if (hit) return hit;
  }

  if (comName) {
    const byCom = index.get("c:" + norm(comName));
    if (byCom) return byCom;
  }
  return null;
}

// --- Wikidata fallback -------------------------------------------------------

async function queryWikidata(sciName: string): Promise<string | null> {
  // Escape backslashes + quotes for the SPARQL string literal.
  const literal = sciName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sparql = `SELECT ?code WHERE { ?t wdt:P225 "${literal}" ; wdt:P3444 ?code . } LIMIT 1`;
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
  const res = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": UA,
    },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`wikidata ${res.status}`);
  const data = (await res.json()) as {
    results?: { bindings?: Array<{ code?: { value?: string } }> };
  };
  const v = data.results?.bindings?.[0]?.code?.value;
  // eBird codes are short alphanumerics; reject anything else as a guard.
  return v && /^[a-z0-9]+$/i.test(v) ? v.toLowerCase() : null;
}
