// R2 key conventions + public URL helpers.
import type { Bindings } from "./types";

export function sciSlug(sciName: string): string {
  return sciName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function datePath(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

export const keys = {
  clip: (ts: number, id: string) => `clips/${datePath(ts)}/${id}.mp3`,
  spectrogram: (ts: number, id: string) => `spectrograms/${datePath(ts)}/${id}.png`,
  speciesFlux: (sci: string, variant: string) => `art/species/${sciSlug(sci)}/flux-${variant}.png`,
  speciesFluxCut: (sci: string, variant: string) => `art/species/${sciSlug(sci)}/flux-${variant}-cut.png`,
  speciesPhoto: (sci: string) => `art/species/${sciSlug(sci)}/photo.jpg`,
  detectionArt: (id: string) => `art/detections/${id}.png`,
  frameLatest: () => `frame/latest.png`,
};

/** Build the public, cache-friendly URL for an R2 key (served by this Worker). */
export function mediaUrl(env: Bindings, key: string | null | undefined): string | null {
  if (!key) return null;
  return `${env.PUBLIC_BASE_URL}${env.MEDIA_PREFIX}/${key}`;
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
