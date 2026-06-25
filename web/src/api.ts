import type { Detection, Species } from "./types";

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export function listSpecies(): Promise<{ species: Species[] }> {
  return getJSON("/api/species");
}

// Most-recent detections regardless of the selected time window (DO hot buffer,
// falling back to D1). Used to seed the sensor-liveness indicator.
export function recent(limit = 1): Promise<{ detections: Detection[] }> {
  return getJSON(`/api/recent?limit=${limit}`);
}

export function detectionsInWindow(fromTs: number, toTs: number): Promise<{
  from: number;
  to: number;
  count: number;
  detections: Detection[];
}> {
  return getJSON(`/api/detections?from=${fromTs}&to=${toTs}&limit=5000`);
}

export interface SpeciesWindowAgg {
  sci_name: string;
  com_name: string;
  count: number;
  last_ts: number;
  best_confidence: number;
}

// Compact per-species aggregates for the collage/cards/list (a few rows instead
// of thousands of raw detections).
export function aggregateWindow(fromTs: number, toTs: number): Promise<{
  from: number;
  to: number;
  species: SpeciesWindowAgg[];
}> {
  return getJSON(`/api/aggregate?from=${fromTs}&to=${toTs}`);
}

export interface PlumagePhoto {
  url: string;
  label: string;
  credit: string;
}

export type PlumageSource = "ebird" | "cub" | "aab" | "obs" | null;

export function speciesDetail(sci: string): Promise<{
  species: Species;
  recent: Detection[];
  cub_url: string | null;
  plumage_photos: PlumagePhoto[];
  plumage_source: PlumageSource;
}> {
  return getJSON(`/api/species/${encodeURIComponent(sci)}`);
}

export function stats(): Promise<{
  totals: { detections: number; species: number };
  top_today: { com_name: string; sci_name: string; n: number }[];
}> {
  return getJSON("/api/stats");
}

export interface DailyStats {
  from: string;
  days: number;
  daily: { date: string; count: number }[];
  top_species: { sci_name: string; com_name: string; count: number }[];
}

export function statsDaily(days = 30): Promise<DailyStats> {
  return getJSON(`/api/stats/daily?days=${days}`);
}

export function statsHourly(date?: string): Promise<{ date: string; hours: number[] }> {
  return getJSON(`/api/stats/hourly${date ? `?date=${date}` : ""}`);
}

export function statsRichness(days = 30): Promise<{
  from: string;
  days: number;
  richness: { date: string; species: number }[];
}> {
  return getJSON(`/api/stats/richness?days=${days}`);
}

export interface DielSpecies {
  sci_name: string;
  com_name: string;
  total: number;
  hours: number[]; // length 24, Eastern local hour-of-day
}

// Per-species calls by Eastern hour-of-day over a window (heatmap + stacked bars).
export function statsDiel(days = 30, limit = 12): Promise<{
  from: number;
  to: number;
  species: DielSpecies[];
  total: number[];
  species_count: number;
}> {
  return getJSON(`/api/stats/diel?days=${days}&limit=${limit}`);
}

export interface CoocSpecies { sci_name: string; com_name: string; buckets: number }
export interface CoocPair { s1: string; s2: string; n: number }

// Which species are detected within the same time bucket (co-occurrence matrix).
export function statsCooccurrence(days = 30, limit = 10): Promise<{
  from: number;
  to: number;
  bucket: number;
  species: CoocSpecies[];
  pairs: CoocPair[];
}> {
  return getJSON(`/api/stats/cooccurrence?days=${days}&limit=${limit}`);
}

export type AnomalyType = "new" | "returned" | "uncommon";
export interface Anomaly {
  sci_name: string;
  com_name: string;
  type: AnomalyType;
  first_seen: number;
  last_seen: number;
  total_count: number;
  days_seen: number;
  gap_days: number;
}

// Notable detections: new-to-site, returned-after-absence, uncommon.
export function statsAnomalies(days = 30): Promise<{ days: number; items: Anomaly[] }> {
  return getJSON(`/api/stats/anomalies?days=${days}`);
}
