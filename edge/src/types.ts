// Shared types for the Birds edge Worker.

export interface Bindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  CACHE: KVNamespace;
  ART_QUEUE: Queue<ArtJob>;
  AVIARY: DurableObjectNamespace<import("./aviary").Aviary>;
  AI: Ai;
  BROWSER: Fetcher;
  ASSETS: Fetcher;
  // vars
  PUBLIC_BASE_URL: string;
  MEDIA_PREFIX: string;
  RARE_SPECIES_DAYS: string;
  FRAME_KEY: string; // shared key gating /media/frame/* (empty = ungated)
  NTFY_TOPIC: string; // ntfy.sh topic for new/rare alerts (empty = disabled)
  // secrets (set via `wrangler secret put`)
  INGEST_TOKEN: string;
  PUSH_TEST_TOKEN: string; // temporary: auth for POST /admin/push-test
  VAPID_PUBLIC_KEY: string; // web-push (empty = disabled)
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string; // mailto: or https: contact for VAPID
}

// Payload the sensor forwarder sends (the `meta` part of the multipart body).
export interface IngestMeta {
  id: string; // ULID generated on the Pi
  ts: number; // unix seconds
  sci_name: string;
  com_name: string;
  confidence: number;
  week?: number;
  lat?: number;
  lon?: number;
  sensor_id?: string;
}

export interface DetectionRow {
  id: string;
  ts: number;
  sci_name: string;
  com_name: string;
  confidence: number;
  week: number | null;
  lat: number | null;
  lon: number | null;
  clip_key: string | null;
  spectrogram_key: string | null;
  art_status: string;
  art_key: string | null;
  sensor_id: string;
}

export interface SpeciesRow {
  sci_name: string;
  com_name: string;
  first_seen: number;
  last_seen: number;
  total_count: number;
  best_confidence: number;
  photo_key: string | null;
  flux_perched_key: string | null;
  flux_flight_key: string | null;
  flux_perched_cut_key: string | null;
  flux_flight_cut_key: string | null;
  wikipedia_url: string | null;
  ebird_code: string | null;
}

// A detection enriched for the dashboard / live feed.
export interface DetectionEvent {
  id: string;
  ts: number;
  sci_name: string;
  com_name: string;
  confidence: number;
  clip_url: string | null;
  spectrogram_url: string | null;
  is_new_species: boolean;
  is_rare: boolean;
}

// Art generation job placed on the queue.
export type ArtJob =
  | { kind: "species"; sci_name: string; com_name: string }
  | { kind: "img2img"; detection_id: string; spectrogram_key: string; sci_name: string; com_name: string };
