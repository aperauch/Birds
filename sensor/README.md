# Sensor node

A Raspberry Pi 5 running **BirdNET-Pi** (unmodified) for capture + detection,
plus a small **forwarder** that ships each detection to the Cloudflare edge.

## 1. Install BirdNET-Pi

Flash **Raspberry Pi OS Lite (64-bit, Trixie)** with Raspberry Pi Imager. In the
customization dialog set username (e.g. `birdnet`), Wi-Fi, hostname `birdnet`,
and enable SSH. Boot, SSH in, then:

```bash
curl -s https://raw.githubusercontent.com/Nachtzuster/BirdNET-Pi/main/newinstaller.sh | bash
```

Reboot when it finishes; the BirdNET-Pi UI is at `http://birdnet.local`.

## 2. Tune for a road-adjacent location

In **Tools → Settings** (these reduce traffic-noise false positives without any
DSP — that's a later phase):

| Setting | Value | Why |
|--------|-------|-----|
| Latitude / Longitude | your exact coords | drives the location species filter |
| Confidence | **0.75** | higher floor rejects marginal noise hits |
| Sensitivity | 1.25 | default; lower slightly if noise persists |
| Species occurrence freq. (`SF_THRESH`) | keep on | filters biogeographically implausible species |
| Privacy threshold | 1–2 | drops chunks containing human voices (residential) |
| Overlap | 0.0 | raise later if you want more chances per call |

Point the **EM272 capsule away from the road**, under an eave, with the
windscreen on. See [`docs/HARDWARE.md`](../docs/HARDWARE.md) for mic placement.

## 3. Install the forwarder

```bash
# as the birdnet user
git clone https://github.com/<you>/Birds.git ~/Birds
cd ~/Birds/sensor
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# configure
sudo cp birds-forwarder.env.example /etc/birds-forwarder.env
sudo nano /etc/birds-forwarder.env      # set INGEST_URL + INGEST_TOKEN
sudo chmod 600 /etc/birds-forwarder.env

# smoke test (sends any backlog once, then exits)
set -a && . /etc/birds-forwarder.env && set +a
.venv/bin/python forwarder.py --once
```

The `INGEST_TOKEN` is the secret you set on the edge with
`wrangler secret put INGEST_TOKEN` (see [`infra/SETUP.md`](../infra/SETUP.md)).

## 4. Run it as a service

```bash
sudo cp birds-forwarder.service /etc/systemd/system/
# edit User=/paths in the unit if your username isn't "birdnet"
sudo systemctl daemon-reload
sudo systemctl enable --now birds-forwarder
journalctl -u birds-forwarder -f
```

## How the forwarder works

- Polls `birds.db` (`detections` table) read-only every `POLL_INTERVAL` seconds.
- For each new row: derives a deterministic UUID, finds the extracted clip under
  `BirdSongs/Extracted/By_Date/<date>/<Common_Name>/`, optionally generates a
  spectrogram with `sox`, and POSTs `meta + clip + spectrogram` to `/ingest`.
- Checkpoints the last processed `rowid` in `state.json`, so restarts never
  drop or duplicate detections. Idempotent at the edge (D1 `INSERT OR IGNORE`).
- **Outbound HTTPS only.** No inbound ports; the Pi is never exposed.

## Notes

- BirdNET-Pi is **not forked** — the forwarder only reads its DB and files, so
  BirdNET-Pi updates stay clean.
- Alternative hook: BirdNET-Pi's Apprise can POST a JSON webhook on each
  detection for lower latency, but it doesn't carry the audio clip — the
  polling forwarder handles both metadata and media, so we use it.
