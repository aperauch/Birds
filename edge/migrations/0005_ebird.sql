-- eBird species code (e.g. "carwre", "amerob"), resolved keylessly from
-- Wikidata (P225 "taxon name" -> P3444 "eBird taxon ID") and cached here so the
-- dashboard can link to the canonical https://ebird.org/species/<code> page
-- instead of the /species/search?q= form (which 404s).

ALTER TABLE species ADD COLUMN ebird_code TEXT;
