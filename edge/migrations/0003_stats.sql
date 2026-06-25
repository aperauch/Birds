-- Phase 4a: incremental daily rollups for analytics.
-- Maintained by an UPSERT on the ingest path (only when a detection actually
-- inserts, so it stays consistent with INSERT OR IGNORE idempotency).

CREATE TABLE IF NOT EXISTS daily_stats (
  date     TEXT NOT NULL,   -- UTC calendar date, 'YYYY-MM-DD'
  sci_name TEXT NOT NULL,
  com_name TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, sci_name)
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats (date);

-- Backfill from any detections that predate this migration so the trends view
-- has history immediately.
INSERT INTO daily_stats (date, sci_name, com_name, count)
SELECT strftime('%Y-%m-%d', ts, 'unixepoch') AS date,
       sci_name,
       com_name,
       COUNT(*) AS count
FROM detections
GROUP BY date, sci_name
ON CONFLICT(date, sci_name) DO UPDATE SET count = excluded.count;
