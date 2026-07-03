# Dashboard SPA

A dependency-light (vanilla TS + Vite, zero runtime deps) single-page app: a
live, self-packing bird collage with a real-time WebSocket feed, a time-window
scrubber, a day-by-day timeline, an analytics view, and a click-to-listen
species sheet with real spectrograms and a shared mini audio player. Built
output (`dist/`) is served by the edge Worker via Workers Assets.

## Develop

Run the edge Worker locally first (it provides `/api`, `/ws`, `/media`, `/ingest`):

```bash
# terminal 1 — edge
cd ../edge && npx wrangler dev      # :8787

# terminal 2 — web (proxies /api, /ws, /media, /ingest to :8787)
npm install
npm run dev                         # :5173
```

The local D1 starts empty. Apply migrations once, then seed a detection
through the real ingest path (use the `INGEST_TOKEN` from `edge/.dev.vars`):

```bash
cd ../edge && npm run db:migrate:local
curl -s http://localhost:8787/ingest \
  -H "Authorization: Bearer <INGEST_TOKEN from .dev.vars>" \
  -F 'meta={"id":"seed-0001","ts":'"$(date +%s)"',"sci_name":"Turdus migratorius","com_name":"American Robin","confidence":0.9,"sensor_id":"dev"}'
```

## Test

```bash
npm test          # Vitest — pure logic (format/color/packing/analytics)
npm run e2e        # Playwright — builds, seeds a fresh local D1, runs against wrangler dev
```

`npm run e2e` drives `scripts/e2e-server.mjs`, which builds the SPA, wipes and
migrates a throwaway local D1 (`edge/.wrangler/e2e-state`), pre-inserts the
fixture species, and starts `wrangler dev --local` on `:8788`. The specs
(`e2e/smoke.spec.ts`) then seed detections through the real `POST /ingest`
path and exercise the app end to end, including a live WebSocket update.

## Build

```bash
npm run build      # tsc + vite build -> dist/
```

The edge `wrangler.jsonc` points `assets.directory` at `../web/dist`, so a
`wrangler deploy` (or `npm run deploy:all` from `edge/`) from `edge/` ships the
latest build.

## Modules

| File | Responsibility |
|------|----------------|
| `main.ts` | controller: window/view/sort state, live+poll aggregation, hash router, theme, keyboard shortcuts |
| `collage.ts` | tile rendering + element-reuse animation (packing math lives in `packing.ts`) |
| `packing.ts` | pure count-weighted sizing + center-out spiral packing |
| `views.ts` | alternate "cards" and "list" layouts |
| `day.ts` | day explorer (`#/day`): one Eastern calendar date, grouped by hour, with an activity strip |
| `trends.ts` | analytics view (`#/trends`): hand-rolled SVG/CSS-grid charts, grouped into sections |
| `charts.ts` | shared SVG chart primitives (line/bar/sparkline) used by Trends and the species modal |
| `analytics.ts` | pure client-side analytics: streaks, diversity, week-over-week, Eastern day-bounds math |
| `modal.ts` | species detail sheet: stats, mini-charts, plumage carousel, recordings, links |
| `player.ts` | shared docked mini audio player (one `<audio>` for the whole app) |
| `waveform.ts` | synthetic canvas waveform, used as a fallback when a recording has no spectrogram |
| `ws.ts` | resilient live-feed WebSocket client |
| `api.ts` | typed fetch wrappers for the read API |
| `img.ts` | Cloudflare Image Transformations URL builder for `/media/*` images |
| `dropdown.ts` | accessible single-select dropdown (time window, sort) |
| `format.ts` / `color.ts` | shared text-formatting and per-species-color helpers |
| `toast.ts` | transient status toast (errors, offline/online) |
| `util.ts` | hash/PRNG helpers |
| `styles.css` | warm, gallery-like theme (light/dark via CSS custom properties) |

## Notes

- The collage reuses tile elements across re-packs and animates position, so new
  birds visibly "shift the cluster to make room."
- Tiles use Wikipedia reference photos, falling back to a FLUX species
  illustration. Packing is rectangular (bounding-box collision) — true
  silhouette-mask packing and the generative/data-art tile style described in
  `../docs/PLAN.md` Phase 3.5b/c were not built.
- Recordings show the real captured spectrogram (with a live playback-progress
  cursor) when one exists, falling back to a client-rendered synthetic
  waveform (`waveform.ts`) otherwise.
- Route changes (`#/`, `#/trends`, `#/day`) are plain DOM swaps, not
  View-Transitioned — crossfading between structurally unrelated layouts reads
  as a confusing double-exposure rather than a clean transition. The
  collage/cards/list layout switch *is* wrapped in `document.startViewTransition`
  (progressive enhancement), since those views share a container and look
  visually related.
