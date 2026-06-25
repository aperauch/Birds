# Hardware build & bill of materials

Two small builds: the **sensor node** (always-on, listens + detects) and the
**frame node** (a color e-paper picture that shows the day's birds).

## Sensor node

| Qty | Item | ~Price | Notes |
|----|------|--------|-------|
| 1 | Raspberry Pi 5 (4 GB is plenty) | $60 | Runs BirdNET-Pi + forwarder |
| 1 | Official 27W USB-C PSU | $14 | Pi 5 is power-hungry |
| 1 | Active cooler / case | $5–15 | 24/7 duty cycle |
| 1 | microSD ≥32 GB (A2) | $10 | OS |
| 1 | NVMe HAT + small SSD (optional) | $25–40 | Durable clip archive; spares the SD |
| 1 | **Primo EM272 / EM272M capsule mic** (see below) | $30–90 | Low-noise audio front-end |
| 1 | **AudioMoth USB Microphone** _(selected)_ | ~$100 | USB-powered (no batteries); 1.2.0-grade audio front-end. Powers the EM272 (plug-in-power) via its 3.5 mm jack and digitizes to the Pi |
| 1 | USB sound card w/ biased mic-in (budget alt.) | $8–35 | CM108 dongle or Sound Blaster Play! 4, if not using the AudioMoth |
| 1 | Furry windscreen ("dead-cat") | $7 | **Essential** outdoors — kills wind roar |
| 1 | Weatherproof mount / junction box | $10 | Capsule out, Pi inside/dry |

### The microphone: Primo EM272 / EM272M

The **Primo EM272** (a.k.a. EM272Z1) is the gold-standard electret capsule for
nature/bird recording — very **low self-noise (~14 dBA)** and a flat, wide
response, so faint distant calls survive. It is **omnidirectional**, which is
ideal for *capturing everything around you*; we get "directionality" the
practical way — **placement + a windscreen + aiming the open face away from the
road**, optionally inside a small reflector. (If you later want true
directionality, the same capsule drops into a parabolic dish.)

The **EM272M** is a Micbooster-exclusive EM272 variant with **improved RF-noise
suppression** (better rejection of Wi-Fi / cellular interference) — worthwhile
right next to an always-on Pi. Same core specs as the EM272.

### Connecting the mic to the Pi

The Raspberry Pi has **no microphone/line input and no ADC**, so an analog
electret can never wire straight to it — it needs a USB digitizer that also
supplies the capsule's **plug-in-power (PIP, ~2–5 V)**. PIP is **not** 48 V
phantom power, so no phantom interface is required.

**Selected front-end (this build) — AudioMoth USB Microphone:**
This build uses the **AudioMoth USB Microphone** (~$100 via GroupGets). It is
**USB-powered (no batteries)** and uses the **same audio front-end as the
standard AudioMoth 1.2.0**, so you get 1.2.0-grade recording quality. (Its product SKU reads `USB-1.0.0` — that is the USB
Microphone's own first revision, *not* the old AudioMoth 1.0.0 audio hardware.)
It has a **3.5 mm jack for an external electret (PIP) mic** plus an
adjustable-gain preamp and is supported on Linux / Raspberry Pi. The EM272 /
EM272M plugs straight in; the AudioMoth supplies bias + gain and presents as a
USB audio device:

```
EM272M (3.5 mm)  ->  AudioMoth USB Microphone  --USB-->  Raspberry Pi
```

You can start on the AudioMoth's built-in mic and add the EM272 later via the
3.5 mm jack.

> The battery-powered standalone **AudioMoth logger** is a *different* product
> (3x AA, records to its own SD card). For this always-on, Pi-tethered build the
> **USB Microphone** is the right one. If you ever buy the standalone logger
> instead, choose **v1.2.0** (newer mic + faster processor than 1.0.0 / 1.1.0).

**Budget alternative — a USB sound card with a biased mic-in:**
A CM108-class USB dongle (e.g. Sabrent AU-MMSA) biases its pink mic jack enough
to run an EM272; the **Creative Sound Blaster Play! 4** is a cleaner step up.
Both work, but bias voltage and preamp noise are worse than the AudioMoth.

**Capsule wiring (only if you buy the bare capsule and solder it):**
- `SIGNAL` -> 3.5 mm **tip** (the dongle/AudioMoth bias rides on this line)
- `GROUND` -> 3.5 mm **sleeve** (the pad with continuity to the metal can)

To skip soldering, buy a **pre-wired Clippy EM272 / EM272M-with-3.5 mm-plug**.

**Where to buy:**

1. **Micbooster / FEL Communications (UK)** — canonical source for genuine
   EM272 / EM272M capsules and ready-made Clippy mics; ships to the US.
   → https://micbooster.com (search "EM272")
2. **AudioMoth USB Microphone** — via GroupGets / LabMaker (US-reachable);
   USB-powered, 1.2.0-grade audio.
   → https://groupgets.com/products/audiomoth-usb-microphone
3. **eBay / Etsy "EM272 USB mic"** — finished plug-and-play mics if you'd
   rather not solder; verify the listing says genuine "Primo EM272 / EM272Z1".

> Tip: in BirdNET-Pi, run `arecord -l` / `arecord -L` to find the USB device,
> select it as the capture card, record **mono @ 48 kHz**, and set the level in
> `alsamixer` (use Mic Boost sparingly — too much raises the noise floor).

### Placement (the high-ROI noise fix)

- Mount the capsule **facing the bird side** (garden/trees), road **behind** it.
- Put it **under an eave** or in a vented box so rain can't hit it; keep the
  **dead-cat windscreen on** at all times outdoors.
- Keep the cable run short, or use the USB version with a short extension.
- Height + soft surroundings beat hard walls (which reflect road noise).

## Frame node

| Qty | Item | ~Price | Notes |
|----|------|--------|-------|
| 1 | Raspberry Pi Zero 2 W | $15 | Pulls a pre-rendered PNG, draws it |
| 1 | **Pimoroni Inky Impression 7.3" (Spectra 6)** | $80 | 6-color e-paper, matte, gallery look |
| 1 | microSD ≥16 GB | $8 | OS |
| 1 | Photo frame (fits the panel) | $15 | Pimoroni sells a matching one |
| 1 | Flat USB power + brick | $12 | Tuck behind the frame |

See [`frame/`](../frame) (Phase 5) for the e-paper client. The art is **dithered
to the panel's fixed 6-color palette** by the edge Frame Worker, so the
FLUX/woodblock-style illustrations read well on e-paper.

## What this build deliberately defers

- **DSP noise cancellation** (high-pass, RNNoise/DeepFilterNet) — the directional
  placement + EM272 low self-noise gets us clean data first; software filtering
  is a later add-on.
- **Speaker / call playback** — deferred for v1 on wildlife-ethics grounds.
