// Notifications for new & rare species via ntfy (https://ntfy.sh).
// No-op when NTFY_TOPIC is unset. A per-species throttle in KV suppresses
// repeats within a window.
import type { Bindings, DetectionEvent } from "./types";

const THROTTLE_SEC = 30 * 60; // at most one alert per species per 30 min

export interface NotifyPayload {
  title: string;
  body: string;
  url?: string;
}

async function sendNtfy(env: Bindings, payload: NotifyPayload): Promise<void> {
  if (!env.NTFY_TOPIC) return;
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      Title: payload.title,
      Tags: "bird",
      ...(payload.url ? { Click: payload.url } : {}),
    },
    body: payload.body,
  }).catch((e) => console.error("ntfy", e));
}

/**
 * Fire a notification for a new or rare detection, throttled to one alert per
 * species per window. Safe to call in waitUntil.
 */
export async function notifyDetection(env: Bindings, event: DetectionEvent): Promise<void> {
  if (!event.is_new_species && !event.is_rare) return;
  if (!env.NTFY_TOPIC) return;

  // Throttle per species (skip if we alerted recently).
  const throttleKey = `notify:${event.sci_name}`;
  if (await env.CACHE.get(throttleKey)) return;
  await env.CACHE.put(throttleKey, String(event.ts), { expirationTtl: THROTTLE_SEC });

  const kind = event.is_new_species ? "New species" : "Rare visitor";
  await sendNtfy(env, {
    title: `${kind}: ${event.com_name}`,
    body: `${event.com_name} just heard (${Math.round(event.confidence * 100)}% confidence).`,
    url: env.PUBLIC_BASE_URL,
  });
}
