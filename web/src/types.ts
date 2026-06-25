export interface Detection {
  id: string;
  ts: number;
  sci_name: string;
  com_name: string;
  confidence: number;
  clip_url: string | null;
  spectrogram_url: string | null;
  art_url?: string | null;
}

export interface Species {
  sci_name: string;
  com_name: string;
  first_seen: number;
  last_seen: number;
  total_count: number;
  best_confidence: number;
  photo_url: string | null;
  flux_perched_url: string | null;
  flux_flight_url: string | null;
  flux_perched_cut_url: string | null;
  flux_flight_cut_url: string | null;
  wikipedia_url: string | null;
  ebird_url: string | null;
}

export type ArtStyle = "photo" | "generative";

// How the main page lays out species: packed collage (default), photo cards, or
// a compact list.
export type ViewMode = "collage" | "cards" | "list";

// Ordering for the cards/list views.
export type SortMode = "recent" | "frequent" | "alpha";

// Aggregated tile shown in the collage for the current time window.
export interface SpeciesAgg {
  sci_name: string;
  com_name: string;
  count: number;
  last_ts: number;
  best_conf: number;
  photo_url: string | null;
  flux_url: string | null; // rectangular FLUX illustration
  cut_url: string | null; // transparent-background FLUX cutout
  art_url: string | null; // per-recording "sound" art (img2img)
  last_id: string; // representative detection id (generative seed)
}

export type WireMessage =
  | { type: "hello"; recent: Detection[] }
  | { type: "detection"; event: Detection & { is_new_species?: boolean; is_rare?: boolean } }
  | { type: "ping"; ts: number };
