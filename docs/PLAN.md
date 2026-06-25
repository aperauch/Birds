# Implementation plan — remaining phases (agent handoff)

This document is a self-contained spec for the **unbuilt** phases of `birds`.
It assumes no prior context beyond this repo. Read
[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`../infra/DEPLOYED.md`](../infra/DEPLOYED.md)
first, then implement phases in order.

## Current state (done & deployed)

Live at **https://birds.aperauch.com** on account `[redacted]`,
zone `aperauch.com`.

- **Phase 1** — edge backbone: `edge/` Worker (Hono) with `/ingest`, `/ws`,
  `/media/*`, `/api/*`, `/admin/reset`. D1 (`birds`), R2 (`birds-media`),
  KV (`birds-cache`), Queue (`birds-art` + DLQ), Aviary Durable Object
  (WebSocket hibernation live feed). Sensor `sensor/forwarder.py` ships
  BirdNET-Pi detections.
- **Phase 2** — dashboard SPA `web/` (vanilla TS + Vite): live feed, collage
  (count-weighted phyllotaxis packing), click-to-listen modal, time-window picker.
- **Phase 3** — art queue consumer `edge/src/art.ts`: Wikipedia photo + FLUX.2
  klein 9B species illustrations (perched/flight) + SDXL img2img of spectrograms.

### Conventions & gotchas (read before editing)

- **Edit `wrangler.jsonc` → run `npx wrangler types`** to regenerate
  `edge/worker-configuration.d.ts`. Then `npm run typecheck`.
- **Deploy:** `cd web && npm run build && cd ../edge && npx wrangler deploy`.
  The Worker serves `web/dist` via the `ASSETS` binding.
- **Bindings** (see `edge/src/types.ts` `Bindings`): `DB`, `MEDIA`, `CACHE`,
  `ART_QUEUE`, `AVIARY`, `AI`, `BROWSER`, `ASSETS`, `INGEST_TOKEN` (secret).
- **R2 key conventions** live in `edge/src/media.ts` (`keys`, `mediaUrl`,
  `sciSlug`). All public media is served at `/media/<key>` with immutable cache.
- **Workers AI**: FLUX.2 klein takes `multipart` and returns `{ image: base64 }`.
  SDXL img2img takes **`image_b64`** (string) + `strength` (use ~0.8; a number
  array or low strength yields blank output) and returns a PNG `ReadableStream`.
  Call via `(env.AI as unknown as {...}).run(...)` (binding types are loose).
- **Queue** consumer batches up to 5 / 5s. Art for one detection lands in ~5s.
- **WAF**: zone managed WAF blocks `/ingest`; a scoped skip rule exists (see
  `infra/DEPLOYED.md`). Don't remove it. New POST endpoints that carry bodies may
  need similar treatment.
- **Auth**: write/admin endpoints check `Authorization: Bearer ${INGEST_TOKEN}`.
  Public read endpoints are open. Put any new admin surface behind the token (or
  Cloudflare Access).
- **Local dev**: `cd edge && npx wrangler dev` (D1/R2/KV/Queues/DO local; AI &
  Browser proxy to prod). `cd web && npm run dev` proxies `/api`,`/ws`,`/media`.
- Node 26 has a global `WebSocket` — handy for integration tests.
- Test data can be wiped any time: `POST /admin/reset` with the bearer token.

---

## Phase 3.5 — Cutout, silhouette-mask packing, generative art

**Goal:** elevate the collage from rectangular cream tiles to true cut-out bird
silhouettes (like Avian Visitors), and add the "generative / data-driven" art
style the owner asked for.

### 3.5a — Background cutout for FLUX art

FLUX renders each bird on a consistent warm cream ground. Produce a transparent
PNG cutout so tiles overlap by silhouette.

- Workers AI has **no background-removal model**, so do a **chroma/luma key**
  against the known cream ground in a Worker.
- Add `edge/src/cutout.ts`: decode the FLUX PNG, flood-fill/threshold pixels
  whose color is within ΔE of the cream ground (sample the 4 corners to get the
  exact bg color), set alpha=0, re-encode PNG.
- Image decode/encode on Workers: use a WASM lib — **`@cf/photon`-style** is not
  available; use [`@cf/image`? no] → use the npm package **`@jsquash/png`**
  (decode/encode) + manual pixel ops, or **`photon-wasm`**. Validate the lib runs
  under `workerd` (no Node FS). If none works, fall back to running cutout in the
  queue consumer via the **Browser Rendering** binding (render the PNG on a
  transparent canvas with a JS chroma-key and screenshot with `omitBackground`).
- Store cutout under `art/species/<slug>/flux-<pose>-cut.png`; add
  `flux_perched_cut_key` / `flux_flight_cut_key` columns (new migration
  `0002_cutout.sql`) or reuse `art_assets` with `kind='flux_cut'`.
- Acceptance: `GET /media/art/species/<slug>/flux-perched-cut.png` is a PNG with
  a transparent background (alpha channel present; corners fully transparent).

### 3.5b — Silhouette masks + mask-aware packing

- Add a build step (Worker or offline script `edge/scripts/build_masks.ts`) that
  downsamples each cutout to ~96px wide, thresholds alpha, and packs a bit-array
  mask. Store masks in KV (`mask:<slug>:<pose>`) or a `masks` D1 table, exposed
  via `GET /api/masks`.
- Extend `web/src/collage.ts`: replace AABB overlap with **mask collision**
  (bitwise overlap test at candidate offsets) so tiles interlock by silhouette,
  not bounding box. Keep AABB as a fast pre-filter. Preserve the existing
  center-out phyllotaxis spiral and shrink-to-fit.
- The collage must still handle tiles **without** a mask (photo-only species) by
  falling back to rectangular collision.
- Acceptance: with ≥10 species that have cutouts, tiles visibly overlap by shape;
  no two silhouettes intersect; layout fits at 390px and 2560px widths.

### 3.5c — Generative / data-driven art style

- Add a 4th art style toggle in the UI: `photo | illustration | sound | generative`.
- `web/src/generative.ts`: deterministically render a tile from a detection's
  metadata (seed = hash of `id`): map confidence→stroke density, hour-of-day→hue,
  `sci_name`→palette, week→texture. Draw to a `<canvas>` or inline SVG. No model
  cost. Must be stable for a given detection id.
- Wire a style selector into `web/src/main.ts` (persist choice in `localStorage`);
  `tileImage()` chooses the source per the active style.
- Acceptance: toggling styles re-skins the whole collage instantly; generative
  art is identical across reloads for the same detections.

---

## Phase 4 — Analytics, exports, BirdWeather

**Goal:** turn the data into insight + make it portable.

### 4a — Rollups & charts

- New migration `0003_stats.sql`: a `daily_stats` table (date, sci_name, count)
  maintained by the ingest path (UPSERT on each detection) **or** a DO Alarm /
  Cron Trigger that aggregates nightly. Prefer incremental UPSERT in `ingest.ts`.
- Expand `edge/src/api.ts`:
  - `GET /api/stats/daily?days=30` → per-day totals + per-species series.
  - `GET /api/stats/hourly?date=YYYY-MM-DD` → dawn-chorus histogram (24 buckets).
  - `GET /api/stats/richness?days=N` → distinct species per day.
- `web/`: add an analytics view (route `#/trends`) with charts. Use a tiny lib
  (e.g. `uplot`, ~40KB) or hand-rolled SVG to keep the bundle small. Charts:
  detections/day, species richness, dawn-chorus heatmap, top species.

### 4b — Exports / public API

- `GET /api/export.csv?from=&to=` → streamed CSV of detections (use a
  `TransformStream`; do not buffer).
- Document the read API in `docs/API.md`.
- Add `Cache-Control` (e.g. 60s) to `/api/stats*` responses; optionally cache in
  KV with short TTL.

### 4c — BirdWeather (optional)

- If the owner wants public sharing, add a Worker cron that forwards new
  detections to a BirdWeather station ID (config via `wrangler secret`/var).
  Gate behind a `BIRDWEATHER_ID` var; no-op when unset.

- Acceptance: trends view renders from real data; `export.csv` downloads and
  opens in a spreadsheet; all new endpoints have `curl` examples in `docs/API.md`.

---

## Phase 5 — Color e-paper wall frame

**Goal:** a framed Inky Impression (Spectra 6) that shows the day's birds.

### 5a — Frame render route (edge)

- Add `GET /frame` (Worker-served HTML): a palette-aware, fixed-size layout
  (e.g. 800×480 for Inky Impression 7.3") of the last 24h — a tight collage +
  date + species count, designed for **6 colors** (bold shapes, no gradients).
- Add `edge/src/frame.ts`: a Worker that calls the **Browser Rendering** binding
  (`env.BROWSER`) to screenshot `/frame` (or uses the REST `/screenshot`), then
  **dithers to the Spectra 6 palette** (Floyd–Steinberg to the 6 fixed RGB
  values) and stores the PNG at R2 key `frame/latest.png`.
  - Palette (verify against the panel datasheet): black, white, red, yellow,
    green, blue.
  - Either dither in the Worker (WASM image lib) or dither on the Pi (Pillow). If
    Worker-side dithering is hard, store the raw screenshot and dither on-device.
- Trigger: a **Cron Trigger** (every 15 min) or the Aviary DO **Alarm** on new
  detections (debounced) regenerates `frame/latest.png`.
- Gate `frame/latest.png` access with a `?k=<FRAME_KEY>` shared key (var) so
  crawlers don't burn render budget (mirror Avian's approach).

### 5b — Frame device client (`frame/`)

- `frame/display.py`: fetch `https://birds.aperauch.com/media/frame/latest.png?k=…`
  on a systemd timer (15 min), dither if not already, push to the panel via the
  Pimoroni **`inky`** library. Skip refresh if the image hash is unchanged.
- `frame/install.sh`: enable SPI/I2C, install `inky`+`Pillow`, register the timer.
- `frame/README.md`: wiring, BOM cross-ref (`docs/HARDWARE.md`), config TOML
  (`base_url`, `frame_key`, refresh interval).
- Acceptance: hitting `/frame` in a browser shows a clean 6-color-friendly layout;
  `frame/latest.png` updates within the cron interval; the Pi renders it on the panel.

---

## Phase 6 — Notifications

**Goal:** alert on new & rare species without a GCP/external dependency.

- **Web push (VAPID):** generate VAPID keys (store as secrets), add
  `POST /api/push/subscribe` (store subscriptions in D1/KV) and send pushes from
  the ingest path when `is_new_species` or `is_rare`. Add a subscribe button in
  the dashboard.
- **ntfy (simplest):** POST to a configurable `ntfy.sh` topic on new/rare species
  (topic via var). No client code needed.
- Throttle: at most one notification per species per `N` minutes (track in KV).
- Make channels independently toggleable via vars (`NTFY_TOPIC`, push keys);
  no-op when unset.
- Acceptance: ingesting a brand-new species triggers exactly one notification on
  each enabled channel; repeats within the window are suppressed.

---

## Suggested order & estimates

1. **Phase 3.5c** generative art (frontend-only, no infra) — quick win.
2. **Phase 4a/4b** analytics + CSV — high value, pure edge+web.
3. **Phase 5** e-paper frame — needs hardware on hand.
4. **Phase 3.5a/3.5b** cutout + masks — trickiest (image processing on workerd).
5. **Phase 6** notifications.

## Definition of done (every phase)

- `cd edge && npm run typecheck` clean; `cd web && npm run build` clean.
- Deployed via `wrangler deploy`; verified with `curl`/a Node WS probe against
  `https://birds.aperauch.com`.
- Test data purged with `POST /admin/reset` before handing back.
- Docs updated: `README.md` status checklist, `ARCHITECTURE.md` phase table, and
  any new endpoints in `docs/API.md`.
