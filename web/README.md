# Dashboard SPA

A dependency-light (vanilla TS + Vite) single-page app: a live, self-packing
bird collage with a real-time WebSocket feed, a time-window scrubber, and a
click-to-listen detail sheet. Built output (`dist/`) is served by the edge
Worker via Workers Assets.

## Develop

Run the edge Worker locally first (it provides `/api`, `/ws`, `/media`):

```bash
# terminal 1 — edge
cd ../edge && npx wrangler dev      # :8787

# terminal 2 — web (proxies /api, /ws, /media to :8787)
npm install
npm run dev                         # :5173
```

## Build

```bash
npm run build      # tsc + vite build -> dist/
```

The edge `wrangler.jsonc` points `assets.directory` at `../web/dist`, so a
`wrangler deploy` from `edge/` ships the latest build.

## Modules

| File | Responsibility |
|------|----------------|
| `main.ts` | controller: window picker, aggregation, wiring |
| `collage.ts` | count-weighted sizing + center-out spiral packing + render |
| `ws.ts` | resilient live feed WebSocket client |
| `api.ts` | typed fetch wrappers for the read API |
| `modal.ts` | species detail sheet (recordings, spectrograms, links) |
| `styles.css` | warm, gallery-like theme |

## Notes

- The collage reuses tile elements across re-packs and animates position, so new
  birds visibly "shift the cluster to make room."
- Tiles currently use Wikipedia reference photos. Phase 3 adds FLUX
  signature-style illustrations + per-recording img2img art and swaps the
  rectangular collision for silhouette-mask packing.
