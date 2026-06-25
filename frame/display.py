#!/usr/bin/env python3
"""Birds e-paper frame client (Phase 5).

Fetches the pre-dithered frame image from the edge and pushes it to a Pimoroni
Inky Impression (Spectra 6) panel. Designed to be invoked by a systemd timer
(every ~15 min); it exits after a single refresh and skips the slow panel update
when the image is unchanged.

Config is read from (first that exists):
  1. $BIRDS_FRAME_CONFIG
  2. /etc/birds-frame.toml
  3. ./config.toml

Example config.toml:
    base_url = "https://birds.aperauch.com"
    frame_key = "the-shared-frame-key"   # optional; matches Worker FRAME_KEY
    saturation = 0.6                       # 0..1, Inky color saturation
"""
from __future__ import annotations

import hashlib
import io
import os
import sys
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    import tomli as tomllib  # type: ignore[no-redef]

import requests
from PIL import Image

STATE_FILE = Path.home() / ".cache" / "birds-frame.hash"
CONFIG_CANDIDATES = [
    os.environ.get("BIRDS_FRAME_CONFIG", ""),
    "/etc/birds-frame.toml",
    str(Path(__file__).resolve().parent / "config.toml"),
]


def load_config() -> dict:
    for candidate in CONFIG_CANDIDATES:
        if candidate and Path(candidate).is_file():
            with open(candidate, "rb") as fh:
                return tomllib.load(fh)
    sys.exit("birds-frame: no config file found (set BIRDS_FRAME_CONFIG or create /etc/birds-frame.toml)")


def fetch_image(base_url: str, frame_key: str) -> bytes:
    url = f"{base_url.rstrip('/')}/media/frame/latest.png"
    params = {"k": frame_key} if frame_key else {}
    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    return resp.content


def already_displayed(data: bytes) -> bool:
    digest = hashlib.sha256(data).hexdigest()
    try:
        if STATE_FILE.read_text().strip() == digest:
            return True
    except FileNotFoundError:
        pass
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(digest)
    return False


def main() -> int:
    cfg = load_config()
    base_url = cfg.get("base_url")
    if not base_url:
        sys.exit("birds-frame: 'base_url' is required in config")
    frame_key = cfg.get("frame_key", "")
    saturation = float(cfg.get("saturation", 0.6))

    try:
        data = fetch_image(base_url, frame_key)
    except requests.RequestException as exc:
        print(f"birds-frame: fetch failed: {exc}", file=sys.stderr)
        return 1

    if already_displayed(data):
        print("birds-frame: image unchanged, skipping refresh")
        return 0

    # Import here so a fetch-only dry run works without the panel libraries.
    from inky.auto import auto

    inky = auto(ask_user=False, verbose=False)
    image = Image.open(io.BytesIO(data)).convert("RGB")
    image = image.resize(inky.resolution)
    # set_image quantizes to the panel's native palette; the source is already
    # dithered to the Spectra 6 colors so this is near-lossless.
    try:
        inky.set_image(image, saturation=saturation)
    except TypeError:
        inky.set_image(image)  # older inky without the saturation kwarg
    inky.show()
    print("birds-frame: panel updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
