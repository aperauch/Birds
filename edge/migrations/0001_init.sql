-- Birds edge schema (D1 / SQLite)
-- Phase 1: detections, species, art assets.

-- One row per unique species ever detected.
CREATE TABLE IF NOT EXISTS species (
  sci_name        TEXT PRIMARY KEY,          -- "Corvus brachyrhynchos"
  com_name        TEXT NOT NULL,             -- "American Crow"
  first_seen      INTEGER NOT NULL,          -- unix seconds
  last_seen       INTEGER NOT NULL,
  total_count     INTEGER NOT NULL DEFAULT 0,
  best_confidence REAL    NOT NULL DEFAULT 0,
  -- cached art references (R2 keys); NULL until generated/fetched
  photo_key       TEXT,                      -- Wikimedia reference photo
  flux_perched_key TEXT,                     -- FLUX signature-style illustration
  flux_flight_key  TEXT,
  wikipedia_url   TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One row per detection event reported by the sensor.
CREATE TABLE IF NOT EXISTS detections (
  id              TEXT PRIMARY KEY,          -- ULID/uuid from the forwarder
  ts              INTEGER NOT NULL,          -- unix seconds of detection
  sci_name        TEXT NOT NULL,
  com_name        TEXT NOT NULL,
  confidence      REAL NOT NULL,
  week            INTEGER,                   -- BirdNET week-of-year (1-48)
  lat             REAL,
  lon             REAL,
  clip_key        TEXT,                      -- R2 key for the mp3 extraction
  spectrogram_key TEXT,                      -- R2 key for the spectrogram PNG
  -- per-recording img2img art derived from this clip's spectrogram
  art_status      TEXT NOT NULL DEFAULT 'pending', -- pending|queued|done|skipped|error
  art_key         TEXT,
  sensor_id       TEXT NOT NULL DEFAULT 'default',
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (sci_name) REFERENCES species (sci_name)
);

CREATE INDEX IF NOT EXISTS idx_detections_ts        ON detections (ts DESC);
CREATE INDEX IF NOT EXISTS idx_detections_sci_ts    ON detections (sci_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_detections_art       ON detections (art_status);

-- Generated / fetched art assets (decouples art lifecycle from detections).
CREATE TABLE IF NOT EXISTS art_assets (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,                 -- 'species' | 'detection'
  ref_id      TEXT NOT NULL,                 -- sci_name or detection.id
  kind        TEXT NOT NULL,                 -- 'photo'|'flux'|'img2img'|'generative'
  variant     TEXT,                          -- e.g. 'perched'|'flight'
  r2_key      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  model       TEXT,                          -- model id used to generate
  meta        TEXT,                          -- JSON blob (prompt, params, attribution)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_art_scope_ref ON art_assets (scope, ref_id);
CREATE INDEX IF NOT EXISTS idx_art_status    ON art_assets (status);
