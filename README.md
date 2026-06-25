# Birds

A live bird collage, real-time dashboard, color e-paper frame, and data
platform driven by a [BirdNET-Pi](https://github.com/Nachtzuster/BirdNET-Pi)
acoustic sensor — built entirely on the Cloudflare Developer Platform.

Live at **https://birds.aperauch.com**.

Inspired by [Avian Visitors](https://theodore.net/projects/AvianVisitors/), but
re-architected around Cloudflare Workers, with a richer art system, real-time
WebSocket updates, a time-travel scrubber, analytics, and a color e-paper frame.

---

## How it works

```
SENSOR (Raspberry Pi 5 + EM272 mic)
  BirdNET-Pi  ──detections──>  forwarder.py ──HTTPS(outbound)──┐
                                                               │
CLOUDFLARE EDGE                                                ▼
  Ingest Worker ─> D1 (detections/species) + R2 (clips/art) + Aviary DO
  Aviary DO     ─> WebSocket live broadcast to dashboard + frame
  Art Worker    ─> FLUX species art, SDXL img2img of spectrograms, photos
  Dashboard     ─> live feed, collage, click-to-listen, timeline, analytics
  Frame Worker  ─> Browser Rendering -> dithered PNG for the e-paper panel
                                                               │
FRAME (Pi Zero 2W + Inky Impression / Spectra 6) <──pulls PNG──┘
```

The Raspberry Pi is **outbound-only** — it is never exposed to the internet.
All public surface lives on Cloudflare.

## Repo layout

| Path       | What                                                                 |
|------------|----------------------------------------------------------------------|
| `edge/`    | Cloudflare Workers: ingest, API, Aviary Durable Object, art, frame   |
| `sensor/`  | Raspberry Pi forwarder + BirdNET-Pi tuning + EM272 mic setup         |
| `web/`     | Dashboard SPA (collage, live feed, timeline, analytics)              |
| `frame/`   | Pi Zero e-paper client                                               |
| `docs/`    | Hardware build, bill of materials, architecture                      |
| `infra/`   | Provisioning notes, bindings, secrets                                |

## Status

- [x] Phase 1 — Cloudflare data backbone (D1, R2, Ingest, Aviary DO)
- [x] Phase 2 — Live dashboard MVP (WebSocket feed, collage, click-to-listen, timeline)
- [x] Phase 3 — Art pipeline (Wikipedia photo, FLUX.2 species art, SDXL img2img of spectrograms)
- [x] Phase 3.5 — Background cutout + silhouette-mask packing + generative data-art
- [x] Phase 4 — Analytics (daily rollups, trends view, charts) + streamed CSV export
- [x] Phase 5 — Color e-paper frame (`/frame` + edge dither + cron + Pi client)
- [x] Phase 6 — Notifications (ntfy + Web Push / VAPID)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[infra/SETUP.md](infra/SETUP.md) to provision and deploy; the read API is
documented in [docs/API.md](docs/API.md).

### Deploy / migrate (after pulling these phases)

```bash
cd edge
npm install                       # adds @cf-wasm/photon + @cloudflare/puppeteer
npx wrangler d1 migrations apply birds --remote   # 0002 cutout, 0003 stats, 0004 push
# Optional config: gate the frame image, enable notifications
npx wrangler secret put VAPID_PUBLIC_KEY          # web push (or leave unset)
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT             # e.g. mailto:you@example.com
# set FRAME_KEY / NTFY_TOPIC vars in wrangler.jsonc as desired
cd ../web && npm run build && cd ../edge && npx wrangler deploy
```

VAPID keys can be generated with `npx web-push generate-vapid-keys` (base64url).

## License

Personal / non-commercial. BirdNET models are CC BY-NC-SA 4.0 (non-commercial
only). Reference media: Wikimedia Commons (photos) and Xeno-Canto (calls), used
with attribution.
