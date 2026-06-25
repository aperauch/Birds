# Birds e-paper frame (Phase 5)

A framed **Pimoroni Inky Impression (Spectra 6)** that shows the day's birds.
A Raspberry Pi (Zero 2 W is plenty) pulls a pre-dithered PNG from the edge on a
systemd timer and pushes it to the panel.

## How it works

```
Worker cron (every 15 min)
  GET /frame  (800x480, 6-color-friendly HTML)
  -> Browser Rendering screenshot
  -> Floyd-Steinberg dither to the Spectra 6 palette
  -> R2 frame/latest.png

Pi (this dir), systemd timer every 15 min
  GET /media/frame/latest.png?k=<FRAME_KEY>
  -> skip if image hash unchanged
  -> inky.set_image() + show()
```

All dithering happens **on the edge** (`edge/src/frame.ts`), so the Pi only
fetches and displays — keeping the device code tiny.

## Hardware

- Raspberry Pi (Zero 2 W / 3 / 4 / 5) with SPI + I2C enabled.
- Inky Impression 7.3" (Spectra 6 / E673), 800x480.
- See [`../docs/HARDWARE.md`](../docs/HARDWARE.md) for the BOM and wiring.

## Install (on the Pi)

```bash
cd ~/Birds/frame
./install.sh
```

`install.sh` enables SPI/I2C, builds a `.venv`, installs
[`requirements.txt`](requirements.txt), drops a default
`/etc/birds-frame.toml`, and registers the `birds-frame.timer`.

Then edit the config and trigger a refresh:

```bash
sudoedit /etc/birds-frame.toml          # set base_url + frame_key
sudo systemctl start birds-frame.service
journalctl -u birds-frame.service -n 30 --no-pager
```

## Config

[`config.toml.example`](config.toml.example):

| Key          | Meaning                                                       |
|--------------|---------------------------------------------------------------|
| `base_url`   | Public edge URL, e.g. `https://birds.aperauch.com`            |
| `frame_key`  | Shared key; must match the Worker `FRAME_KEY` var (or empty)  |
| `saturation` | Inky color saturation 0.0..1.0 (default 0.6)                  |

## Notes

- The client computes a SHA-256 of the fetched PNG and skips the (slow) panel
  refresh when nothing changed, so the e-paper isn't needlessly cycled.
- To preview the layout in a browser, open `<base_url>/frame`.
- To force the edge to regenerate immediately:
  `curl -X POST -H "Authorization: Bearer $INGEST_TOKEN" <base_url>/admin/frame`.
