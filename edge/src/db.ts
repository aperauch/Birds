// D1 query helpers.
import type { Bindings, DetectionRow, IngestMeta, SpeciesRow } from "./types";

/**
 * Upsert a species row and bump aggregates. Returns whether this is the
 * first time we have ever seen the species (drives "new species" UX).
 */
export async function upsertSpecies(
  db: D1Database,
  meta: IngestMeta,
): Promise<{ isNewSpecies: boolean }> {
  const existing = await db
    .prepare("SELECT sci_name FROM species WHERE sci_name = ?")
    .bind(meta.sci_name)
    .first<{ sci_name: string }>();

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO species (sci_name, com_name, first_seen, last_seen, total_count, best_confidence)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .bind(meta.sci_name, meta.com_name, meta.ts, meta.ts, meta.confidence)
      .run();
    return { isNewSpecies: true };
  }

  await db
    .prepare(
      `UPDATE species
         SET last_seen = MAX(last_seen, ?),
             total_count = total_count + 1,
             best_confidence = MAX(best_confidence, ?),
             com_name = ?,
             updated_at = unixepoch()
       WHERE sci_name = ?`,
    )
    .bind(meta.ts, meta.confidence, meta.com_name, meta.sci_name)
    .run();
  return { isNewSpecies: false };
}

/**
 * Insert a detection idempotently. Returns whether a NEW row was written
 * (false on a duplicate id), so callers can avoid double-counting rollups.
 */
export async function insertDetection(
  db: D1Database,
  meta: IngestMeta,
  clipKey: string | null,
  spectrogramKey: string | null,
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO detections
         (id, ts, sci_name, com_name, confidence, week, lat, lon, clip_key, spectrogram_key, sensor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      meta.id,
      meta.ts,
      meta.sci_name,
      meta.com_name,
      meta.confidence,
      meta.week ?? null,
      meta.lat ?? null,
      meta.lon ?? null,
      clipKey,
      spectrogramKey,
      meta.sensor_id ?? "default",
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Increment the daily rollup for a detection's UTC calendar date. */
export async function bumpDailyStats(db: D1Database, meta: IngestMeta): Promise<void> {
  const date = new Date(meta.ts * 1000).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  await db
    .prepare(
      `INSERT INTO daily_stats (date, sci_name, com_name, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(date, sci_name)
       DO UPDATE SET count = count + 1, com_name = excluded.com_name`,
    )
    .bind(date, meta.sci_name, meta.com_name)
    .run();
}

/**
 * A species is "rare" if it has not been seen in the last `rareDays` days
 * (other than right now). Mirrors BirdNET-Pi's rare-species highlight.
 */
export async function isRareSpecies(
  db: D1Database,
  sciName: string,
  nowTs: number,
  rareDays: number,
): Promise<boolean> {
  const cutoff = nowTs - rareDays * 86400;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM detections
        WHERE sci_name = ? AND ts < ? AND ts >= ?`,
    )
    .bind(sciName, nowTs, cutoff)
    .first<{ c: number }>();
  return (row?.c ?? 0) === 0;
}

export async function recentDetections(
  db: D1Database,
  limit: number,
  beforeTs?: number,
): Promise<DetectionRow[]> {
  const stmt = beforeTs
    ? db
        .prepare("SELECT * FROM detections WHERE ts < ? ORDER BY ts DESC LIMIT ?")
        .bind(beforeTs, limit)
    : db.prepare("SELECT * FROM detections ORDER BY ts DESC LIMIT ?").bind(limit);
  const { results } = await stmt.all<DetectionRow>();
  return results ?? [];
}

// Per-species aggregates for a time window. Powers the collage/cards/list view
// directly (no need to ship thousands of raw detection rows to the client).
export interface WindowAgg {
  sci_name: string;
  com_name: string;
  count: number;
  last_ts: number;
  best_confidence: number;
}

export async function aggregateWindow(
  db: D1Database,
  fromTs: number,
  toTs: number,
): Promise<WindowAgg[]> {
  const { results } = await db
    .prepare(
      `SELECT sci_name,
              MAX(com_name)    AS com_name,
              COUNT(*)         AS count,
              MAX(ts)          AS last_ts,
              MAX(confidence)  AS best_confidence
         FROM detections
        WHERE ts >= ? AND ts < ?
        GROUP BY sci_name
        ORDER BY count DESC`,
    )
    .bind(fromTs, toTs)
    .all<WindowAgg>();
  return results ?? [];
}

export async function detectionsInWindow(
  db: D1Database,
  fromTs: number,
  toTs: number,
  limit = 2000,
): Promise<DetectionRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM detections WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?",
    )
    .bind(fromTs, toTs, limit)
    .all<DetectionRow>();
  return results ?? [];
}

export async function getSpecies(
  db: D1Database,
  sciName: string,
): Promise<SpeciesRow | null> {
  return db
    .prepare("SELECT * FROM species WHERE sci_name = ?")
    .bind(sciName)
    .first<SpeciesRow>();
}

export async function listSpecies(db: D1Database): Promise<SpeciesRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM species ORDER BY total_count DESC")
    .all<SpeciesRow>();
  return results ?? [];
}
