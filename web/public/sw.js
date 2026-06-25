// Birds service worker.
//   1. Web Push notifications (Phase 6).
//   2. Caching to speed up repeat loads:
//        - hashed /assets/* + Google Fonts -> cache-first (immutable)
//        - navigations (index.html)        -> network-first, cache fallback
//        - /api/species                    -> stale-while-revalidate
//      Live/data endpoints (/api/recent, /api/aggregate, /ws, /media, images)
//      are left to the browser HTTP cache / network so data stays fresh.
const CACHE = "birds-cache-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fetching = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fetching;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  const sameOrigin = url.origin === self.location.origin;
  const isFont =
    url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

  if (sameOrigin && url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req)); // hashed, immutable
  } else if (isFont) {
    event.respondWith(cacheFirst(req));
  } else if (sameOrigin && url.pathname === "/api/species") {
    event.respondWith(staleWhileRevalidate(req));
  } else if (req.mode === "navigate") {
    event.respondWith(networkFirst(req)); // fresh HTML (+ asset hashes), cache offline
  }
  // Everything else (live APIs, /ws, /media, /cdn-cgi/image) -> default handling.
});

// --- Web Push -------------------------------------------------------------
self.addEventListener("push", (event) => {
  let data = { title: "New bird detected", body: "", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) {
    /* non-JSON payload; keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || "birds",
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
