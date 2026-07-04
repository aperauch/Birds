# 🐦 Birds

A little microphone outside listens for birdsong, an AI model figures out
which species is singing, and this project turns that into a live dashboard —
plus a color e-paper picture frame that shows today's visitors.

**See it live: [birds.aperauch.com](https://birds.aperauch.com)**

Built entirely on the [Cloudflare Developer Platform](https://developers.cloudflare.com/)
(Workers, D1, R2, Durable Objects, Queues, Workers AI), fed by a
[BirdNET-Pi](https://github.com/Nachtzuster/BirdNET-Pi) acoustic sensor.
Inspired by [Avian Visitors](https://theodore.net/projects/AvianVisitors/), but
re-architected around Workers with a richer art pipeline, real-time updates,
and a full analytics suite.

---

## What you get

- 🟢 **Live collage** of every bird heard, updating in real time over a
  WebSocket — no refresh needed
- 🔊 **Click any bird** to hear the real recording and watch a real
  spectrogram scrub by
- 🎨 **Species art**: an AI-generated illustration on first sighting, plus a
  real reference photo (eBird / Wikipedia / iNaturalist, whichever has one)
- 📈 **Trends & analytics**: daily activity, a dawn-chorus-by-hour heatmap,
  which species get heard together, streaks and records, and a CSV export of
  your whole detection history
- 🖼️ **A physical picture frame**: a Raspberry Pi + color e-paper panel that
  displays a dithered daily collage of who's been singing
- 🔔 **Notifications** (via [ntfy](https://ntfy.sh)) when a new or rare
  species shows up
- 📱 Installable as a PWA, dark mode, keyboard shortcuts, works great on
  mobile

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

The Raspberry Pi is **outbound-only** — it's never exposed to the internet.
Everything public lives on Cloudflare.

## Repo layout

| Path       | What                                                                 |
|------------|----------------------------------------------------------------------|
| `edge/`    | Cloudflare Workers: ingest, API, Aviary Durable Object, art, frame   |
| `web/`     | Dashboard SPA (collage, live feed, timeline, analytics)              |
| `sensor/`  | Raspberry Pi forwarder + BirdNET-Pi tuning + EM272 mic setup         |
| `frame/`   | Pi Zero e-paper client                                               |
| `docs/`    | Hardware build & bill of materials, architecture, API reference      |
| `infra/`   | Provisioning notes, bindings, secrets                                |

## Curious how deep this goes?

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/HARDWARE.md](docs/HARDWARE.md) — the mic, the Pi, the e-paper frame, and what it costs
- [docs/API.md](docs/API.md) — the public read API
- [infra/SETUP.md](infra/SETUP.md) — provision your own Cloudflare resources and deploy

<details>
<summary><b>Build status</b> (click to expand)</summary>

- [x] Phase 1 — Cloudflare data backbone (D1, R2, Ingest, Aviary DO)
- [x] Phase 2 — Live dashboard MVP (WebSocket feed, collage, click-to-listen, timeline)
- [x] Phase 3 — Art pipeline (Wikipedia photo, FLUX.2 species art, SDXL img2img of spectrograms)
- [ ] Phase 3.5 — Background cutout (3.5a) done; silhouette-mask packing and
      the generative/data-art tile style (3.5b/c) were not built — the collage
      still packs rectangular tiles (see `web/README.md` Notes)
- [x] Phase 4 — Analytics (daily rollups, trends view, charts) + streamed CSV export
- [x] Phase 5 — Color e-paper frame (`/frame` + edge dither + cron + Pi client)
- [x] Phase 6 — Notifications via ntfy (Web Push / VAPID was built but never
      worked and has been removed)
- [x] Phase 7 — Dashboard polish & analytics expansion: self-hosted fonts,
      theme-aware charts, error/retry states, mobile bottom-sheet modal, a day
      explorer (`#/day`), a shared mini audio player, real spectrograms with a
      playback cursor, expanded Trends (records/streaks, sparklines,
      diversity, weekday×hour punchcard, dawn-chorus-vs-sunrise), and unit
      (Vitest) + end-to-end (Playwright) test suites for `web/` and `edge/`

</details>

## Want to run your own?

Provisioning and deploy steps are in [infra/SETUP.md](infra/SETUP.md). Rough shape:

```bash
cd edge
npm install                       # adds @cf-wasm/photon + @cloudflare/puppeteer
npx wrangler d1 migrations apply birds --remote
# Optional: gate the frame image, enable notifications, sunrise overlay
npx wrangler secret put SITE_LAT                  # optional: Trends dawn-chorus sunrise overlay
npx wrangler secret put SITE_LON                  # negative = west; never exposed to the client
# set FRAME_KEY / NTFY_TOPIC vars in wrangler.jsonc as desired
cd ../web && npm run build && cd ../edge && npx wrangler deploy
```

## License

Personal / non-commercial only — see [LICENSE.md](LICENSE.md) (driven by
BirdNET's CC BY-NC-SA 4.0 terms).
