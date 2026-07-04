# Architecture

## Goals

Keep the **proven BirdNET-Pi detection core** untouched, and build an
**artistic + interactive + data** platform around it, entirely on Cloudflare.
The Raspberry Pi is a sensor that only makes **outbound** calls; everything
public lives at the edge.

## Data flow

```
 ┌──────────────────────── Raspberry Pi 5 (sensor) ────────────────────────┐
 │  EM272 mic ─> BirdNET-Pi (arecord 48kHz -> TFLite) -> birds.db + clips   │
 │  forwarder.py: poll birds.db -> POST meta+clip+spectrogram (HTTPS out)   │
 └───────────────────────────────────┬─────────────────────────────────────┘
                                      │  POST /ingest (Bearer token)
                                      ▼
 ┌────────────────────────────── Cloudflare ───────────────────────────────┐
 │  Worker (Hono router)                                                     │
 │   /ingest  -> R2 put(clip,spectro) -> D1 upsert species + insert detection│
 │            -> Aviary DO .broadcast()  -> ART_QUEUE.send()                 │
 │   /ws      -> Aviary DO (WebSocket hibernation; live fan-out)             │
 │   /media/* -> R2 (immutable, cached)                                      │
 │   /api/*   -> D1 reads (recent, window, species, stats)                   │
 │   *        -> ASSETS (dashboard SPA)                                      │
 │                                                                           │
 │  Queue consumer (birds-art)                                               │
 │   species  -> Wikipedia photo+summary (now); FLUX perched/flight (P3)     │
 │   img2img  -> SDXL stylization of the spectrogram (P3)                    │
 │                                                                           │
 │  D1 birds: species, detections, art_assets                               │
 │  R2 birds-media: clips/ spectrograms/ art/ frame/                        │
 └───────────────────────────────────┬─────────────────────────────────────┘
                                      │  GET /media/frame/latest.png (timer)
                                      ▼
 ┌──────────────── Pi Zero 2 W (frame) — Phase 5 ──────────────────────────┐
 │  fetch dithered PNG -> Inky Impression (Spectra 6) e-paper               │
 └──────────────────────────────────────────────────────────────────────────┘
```

## Why a single Durable Object (`Aviary`)

One global instance is the coordination point for the live feed: it holds a
small ring buffer of recent detections (replayed to each new client on connect)
and fans out new detections to all connected dashboards/frames over WebSockets
using the **Hibernation API**, so idle connections cost nothing. Detection
volume from one sensor is low, so a single DO is far below any throughput limit.

## Idempotency & durability

- The forwarder assigns a **deterministic UUID** (uuid5 of sensor+date+time+file)
  and checkpoints the last processed `rowid`. Re-sends are safe.
- The edge uses `INSERT OR IGNORE` on `detections.id`, so duplicates are no-ops.
- R2 keys are **content-addressed by detection id + date**, so re-uploads are
  idempotent and cacheable forever (`immutable`).

## Security

- `/ingest` requires a bearer secret (`INGEST_TOKEN`).
- The Pi accepts **no inbound** connections.
- Admin/maintenance surfaces (when added) sit behind **Cloudflare Access**.
- BirdNET-Pi's human-voice privacy filter stays on (residential location).

## Phasing

| Phase | Scope | State |
|------|-------|-------|
| 1 | Edge backbone (D1/R2/Ingest/DO/API) + sensor forwarder | **done** |
| 2 | Dashboard SPA: live feed, collage, click-to-listen, timeline | **done** |
| 3 | Art: Wikipedia photo + FLUX.2 species art + SDXL img2img | **done** |
| 3.5 | Background cutout + silhouette-mask packing + generative data-art | **done** |
| 4 | Analytics (daily rollups + trends charts) + streamed CSV export | **done** |
| 5 | Color e-paper frame (Browser Rendering + Floyd–Steinberg dither) | **done** |
| 6 | Notifications (ntfy; Web Push was removed — never worked) | **done** |

The original self-contained specs live in [PLAN.md](PLAN.md). Read API is in
[API.md](API.md).

## Phase 3.5–6 implementation notes

- **Cutout (`edge/src/cutout.ts`)** decodes FLUX PNGs with `@cf-wasm/photon`,
  corner-samples the cream ground, flood-fills the connected exterior to
  `alpha=0`, and re-encodes. Masks (`edge/src/masks.ts`) downsample the cutout
  alpha to a packed 1-bit silhouette stored in KV (`mask:<slug>:<pose>`),
  served via `GET /api/masks`. The collage (`web/src/collage.ts`) packs by a
  coarse cell-occupancy grid so silhouettes interlock; un-masked tiles keep a
  rectangular halo.
- **Generative art (`web/src/generative.ts`)** renders a deterministic canvas
  tile from a detection's id/confidence/hour/week — stable across reloads.
- **Analytics**: ingest UPSERTs `daily_stats` only on a genuine insert (keeps
  idempotency); `GET /api/stats/{daily,hourly,richness}` + streamed
  `GET /api/export.csv`. Trends view at `#/trends`.
- **Frame**: `GET /frame` renders a 6-color-friendly 800×480 page; a 15-min
  Cron Trigger screenshots it via Browser Rendering, Floyd–Steinberg dithers to
  the Spectra 6 palette (`edge/src/frame.ts`), and stores `frame/latest.png`
  (gated by `FRAME_KEY`). The Pi client lives in `frame/`.
- **Notifications (`edge/src/notify.ts`)**: ntfy, throttled per species in
  KV. (Web Push / VAPID was built but never worked and has been removed.)

## Deferred

- **DSP noise filtering** (the road) — directional EM272 placement first.
- **Speaker / call-and-response** — wildlife-ethics; revisit with guardrails.
- **Vectorize "find similar song"** — stretch once embeddings are produced.
