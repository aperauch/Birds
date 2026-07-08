# 🐦 Birds

A little microphone outside listens for birdsong, an AI model figures out
which species is singing, and this project turns that into a live dashboard.

**See it live: [birds.aperauch.com](https://birds.aperauch.com)**

Built entirely on the [Cloudflare Developer Platform](https://developers.cloudflare.com/)
(Workers, D1, R2, Durable Objects, Queues, Workers AI), fed by a
[BirdNET-Pi](https://github.com/Nachtzuster/BirdNET-Pi) acoustic sensor.
Inspired by [Avian Visitors](https://theodore.net/projects/AvianVisitors/), but
developed to be hosted as Cloudflare Workers using Typescript.

---

## What you get

- 🟢 **Live collage** of every bird heard, updating in real time over a
  WebSocket — no refresh needed
- 🔊 **Click any bird** to hear the real recording and watch a real
  spectrogram scrub by
- 📈 **Trends & analytics**: daily activity, a dawn-chorus-by-hour heatmap,
  which species get heard together, streaks and records, and a CSV export of
  your whole detection history
- 🔔 **Notifications** (via [ntfy](https://ntfy.sh)) when a new or rare
  species shows up
- 📱 Installable as a PWA, dark mode, keyboard shortcuts, works great on
  mobile

## How it works

```
SENSOR (Raspberry Pi 5 + AudioMoth mic)
  BirdNET-Pi  ──detections──>  forwarder.py ──HTTPS(outbound)──┐
                                                               │
CLOUDFLARE EDGE                                                ▼
  Ingest Worker ─> D1 (detections/species) + R2 (clips/art) + Aviary DO
  Aviary DO     ─> WebSocket live broadcast to dashboard + frame
  Art Worker    ─> photo (Macaulay/Wikipedia), FLUX species-art fallback,
                   SDXL img2img of spectrograms (generated, not shown in the UI)
  Dashboard     ─> live feed, collage, click-to-listen, timeline, analytics
  Frame Worker  ─> Browser Rendering -> dithered PNG for the e-paper panel
                                                               │
FRAME (Pi Zero 2W + Inky Impression / Spectra 6 — not yet built) <──pulls PNG──┘
```

The Raspberry Pi is **outbound-only** — it's never exposed to the internet.
Everything public lives on Cloudflare.

## Repo layout

| Path       | What                                                                 |
|------------|----------------------------------------------------------------------|
| `edge/`    | Cloudflare Workers: ingest, API, Aviary Durable Object, art, frame   |
| `web/`     | Dashboard SPA (collage, live feed, timeline, analytics)              |
| `sensor/`  | Raspberry Pi forwarder + BirdNET-Pi tuning + EM272 mic setup         |
| `frame/`   | Pi Zero e-paper client — not yet built or tested on real hardware   |
| `docs/`    | Hardware build & bill of materials, architecture, API reference      |
| `infra/`   | Provisioning notes, bindings, secrets                                |

<details>
<summary><b>AudioMoth USB microphone: firmware, udev &amp; gain gotchas</b> (click to expand)</summary>

If the sensor's mic is (or becomes) an AudioMoth run in USB-microphone mode
instead of the EM272 capsule, a few non-obvious things bit us getting it
working on a Raspberry Pi 5 (Raspberry Pi OS Lite):

- **Two separate firmware families, easy to conflate.** AudioMoth-Firmware-Basic
  (standard recording firmware, currently `1.12.1`) and AudioMoth-USB-Microphone
  (the firmware that makes it enumerate as a USB Audio Class mic, currently
  `1.3.2`) have independent version numbers. "Updating to the latest firmware"
  through the AudioMoth Flash App's default option silently reflashes the
  *basic* firmware over the USB-microphone one — the device stops showing up
  in `arecord -L` because the basic firmware only exposes a USB HID
  config interface, not USB audio streaming. Fix: in the Flash App, explicitly
  pick **AudioMoth USB Microphone** from the firmware menu, not the default
  firmware. Also make sure the physical switch is set to **DEFAULT** (not
  `CUSTOM`, not `USB/OFF`) so it enumerates as an audio device at all.

- **Gain isn't configurable from the AudioMoth Configuration App** once
  running USB-microphone firmware — that app only understands the basic
  recording firmware. Use the
  [AudioMoth-USB-Microphone-Cmd](https://github.com/OpenAcousticDevices/AudioMoth-USB-Microphone-Cmd)
  CLI tool instead (works headless over SSH, no desktop needed — install via
  its `AudioMothUSBMicrophoneBuilder1.0.2.sh` release script, which compiles
  from source and drops the binary in `/usr/local/bin`):
  ```bash
  AudioMoth-USB-Microphone list           # confirm it's seen, get device ID
  AudioMoth-USB-Microphone read           # current sample rate / gain / filters
  AudioMoth-USB-Microphone update gain 4  # 0=Low … 4=High (33.0x); default is 2=Medium (15.0x)
  AudioMoth-USB-Microphone persist        # survive power cycles
  ```
  `update` only touches gain, unlike `config`, which resets every unspecified
  setting back to default. Gain `4` (High, 33.0x) is what you want for
  picking up genuinely distant/quiet birds. **Careful when bench-testing with
  a phone/speaker playing bird calls, though** — at gain `4`, a playback
  source just a few feet away clips hard enough that BirdNET-Pi stops
  detecting anything (clipped audio reads as broadband noise in the
  spectrogram BirdNET classifies on, masking the call structure). That's a
  testing-distance artifact, not a real-world problem: outdoor birds are far
  enough away that gain `4` doesn't clip on them. If you do want to bench-test
  up close, either back off to gain `3` (25.05x) temporarily or move the
  speaker further away.

- **Beyond gain: filtering and sample rate for more range.** Gain amplifies
  signal and noise together — it doesn't improve range on its own. Two more
  effective levers:
  - **High-pass filter** removes low-frequency noise (wind, traffic rumble,
    HVAC hum) that eats into headroom and forces gain down. Most bird song
    lives above ~1–2 kHz, so cutting below that frees up gain to work harder
    on the frequencies that matter:
    ```bash
    AudioMoth-USB-Microphone config 48000 gain 4 hpf 1500
    AudioMoth-USB-Microphone persist
    ```
    (`config`, unlike `update`, resets every *unspecified* setting to
    default — always respecify sample rate + gain alongside a filter.)
  - **Sample rate 48 kHz, not 384 kHz.** 384 kHz is meant for bats
    (ultrasonic content); bird song tops out well under 20 kHz. Running at
    384 kHz just makes BirdNET-Pi downsample every chunk before analysis,
    burning Pi CPU for zero detection benefit.

  Leave `LOWGAINRANGE` and `DISABLE48HZ` alone — `LOWGAINRANGE` is a *less*
  sensitive range meant for loud close-up sources (e.g. bats in hand), and
  `DISABLE48HZ` extends the low-frequency response *down*, letting in more of
  the rumble the high-pass filter above is trying to remove.

  For a bigger jump than any config change, firmware 1.3.2 added the
  `MICROPHONE` command to switch to an **external mic** — a directional
  (shotgun) mic aimed at your area of interest gets real beamforming gain,
  which outperforms any internal filter/gain tweak:
  ```bash
  AudioMoth-USB-Microphone microphone external
  ```

- **udev rule has to live in `/etc/udev/rules.d/`, not `/lib/udev/rules.d/`.**
  A rule in `/lib` gets silently shadowed by Debian's default
  `50-udev-default.rules` (which assigns the USB device node `0664 root`), so
  the CLI tool sees the device over `lsusb` but reports "No AudioMoth USB
  Microphones found" — it can't open the HID interface without write access.
  Fix:
  ```bash
  sudo tee /etc/udev/rules.d/99-audiomoth.rules >/dev/null <<'EOF'
  SUBSYSTEM=="usb", ATTRS{idVendor}=="16d0", ATTRS{idProduct}=="06f3", MODE="0666"
  EOF
  sudo udevadm control --reload-rules
  sudo udevadm trigger --attr-match=idVendor=16d0
  ```
  then physically unplug/replug the device (`udevadm control --reload-rules`
  alone doesn't re-apply rules to an already-enumerated device).

- **BirdNET-Pi's Advanced Settings → Audio Card must be set to `default`**
  (routes through PulseAudio), not a specific `dsnoop:CARD=...` device —
  despite BirdNET-Pi's own hint text suggesting `dsnoop` when available,
  `default` is what actually works reliably with the AudioMoth.

</details>

## Curious how deep this goes?

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/HARDWARE.md](docs/HARDWARE.md) — the mic, the Pi, the e-paper frame, and what it costs
- [docs/API.md](docs/API.md) — the public read API
- [infra/SETUP.md](infra/SETUP.md) — provision your own Cloudflare resources and deploy

<details>
<summary><b>Build status</b> (click to expand)</summary>

- [x] Phase 1 — Cloudflare data backbone (D1, R2, Ingest, Aviary DO)
- [x] Phase 2 — Live dashboard MVP (WebSocket feed, collage, click-to-listen, timeline)
- [x] Phase 3 — Art pipeline (Wikipedia/Macaulay photo, FLUX species-art
      fallback, SDXL img2img of spectrograms). The spectrogram artwork is
      generated and stored in R2 but isn't surfaced anywhere in the dashboard
      UI — see Phase 3.5
- [ ] Phase 3.5 — Background cutout (3.5a) is generated but unused; silhouette-
      mask packing, the generative/data-art tile style, and any user-facing
      photo/art toggle (3.5b/c) were not built. The "Art" concepts (stylized
      spectrograms, cutouts, generative tiles) that once existed have been
      removed from the live dashboard at birds.aperauch.com — tiles show only
      a real photo, or a plain FLUX illustration as a silent fallback when no
      photo exists. The collage always packs rectangular tiles (see
      `web/README.md` Notes)
- [x] Phase 4 — Analytics (daily rollups, trends view, charts) + streamed CSV export
- [ ] Phase 5 — Color e-paper frame: the edge side (`/frame`, dithering,
      15-min cron) is deployed, but the physical Pi Zero + Inky panel and its
      client code (`frame/`) have not been built or tested against real
      hardware
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
