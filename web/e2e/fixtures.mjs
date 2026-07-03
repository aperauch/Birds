// Shared E2E fixtures — imported by both the server harness (scripts/e2e-server.mjs,
// which pre-inserts the species rows) and the Playwright specs (which POST the
// detections). Pre-inserting species keeps `isNewSpecies` false on ingest so the
// harness never enqueues art jobs (Workers AI would bill even from local dev).
export const BASE_URL = "http://127.0.0.1:8788";
export const INGEST_TOKEN = "e2e-token";

export const SPECIES = [
  { sci: "Cardinalis cardinalis", com: "Northern Cardinal" },
  { sci: "Cyanocitta cristata", com: "Blue Jay" },
  { sci: "Poecile carolinensis", com: "Carolina Chickadee" },
  { sci: "Zenaida macroura", com: "Mourning Dove" },
];

/**
 * Deterministic detection batch relative to `nowS` (unix seconds). Ids are
 * stable so re-seeding is idempotent (`INSERT OR IGNORE`). The newest seeded
 * detection is a Mourning Dove, so the live-update spec can post a Blue Jay
 * and assert the ticker's newest chip changes.
 */
export function seedDetections(nowS) {
  const d = (id, minAgo, s, confidence) => ({
    id: `e2e-${id}`,
    ts: nowS - minAgo * 60,
    sci_name: s.sci,
    com_name: s.com,
    confidence,
    sensor_id: "e2e",
  });
  const [cardinal, jay, chickadee, dove] = SPECIES;
  return [
    d("0001", 55, cardinal, 0.91),
    d("0002", 48, cardinal, 0.84),
    d("0003", 44, jay, 0.77),
    d("0004", 39, chickadee, 0.8),
    d("0005", 33, cardinal, 0.95),
    d("0006", 28, jay, 0.7),
    d("0007", 21, chickadee, 0.88),
    d("0008", 15, jay, 0.9),
    d("0009", 9, cardinal, 0.86),
    d("0010", 4, dove, 0.93),
  ];
}
