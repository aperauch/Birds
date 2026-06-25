#!/usr/bin/env python3
"""
Birds sensor forwarder.

Watches the BirdNET-Pi SQLite database for new detections and ships each one
(metadata + audio clip + spectrogram) to the Cloudflare edge ingest Worker.

Design goals:
  * Outbound-only. The Pi never accepts inbound connections.
  * Idempotent. Detections get a deterministic UUID so re-sends dedupe at D1.
  * Non-invasive. BirdNET-Pi is NOT forked; we only read its DB + files.
  * Resilient. Network failures are retried with backoff; progress is durably
    checkpointed in state.json so nothing is dropped or double-counted.

Config via environment (see birds-forwarder.env.example):
  INGEST_URL            e.g. https://birds.aperauch.com/ingest   (required)
  INGEST_TOKEN          shared bearer secret                      (required)
  BIRDNETPI_DB          default: ~/BirdNET-Pi/scripts/birds.db
  EXTRACTED_DIR         default: ~/BirdSongs/Extracted
  SENSOR_ID             default: default
  POLL_INTERVAL         seconds between DB polls (default: 10)
  MIN_CONFIDENCE        client-side floor, 0..1 (default: 0.0 -> rely on BirdNET-Pi)
  MAKE_SPECTROGRAM      "1" to generate a PNG via sox if none exists (default: 1)
  LAT, LON              optional overrides for reported coordinates
"""
from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

import requests

log = logging.getLogger("forwarder")

# Stable namespace so the same detection always maps to the same UUID.
_NS = uuid.UUID("b17d5e7e-0000-4000-8000-000000000000")

STATE_PATH = Path(__file__).resolve().parent / "state.json"


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


class Config:
    def __init__(self) -> None:
        home = Path.home()
        self.ingest_url = env("INGEST_URL")
        self.ingest_token = env("INGEST_TOKEN")
        self.db_path = Path(env("BIRDNETPI_DB", str(home / "BirdNET-Pi/scripts/birds.db")))
        self.extracted = Path(env("EXTRACTED_DIR", str(home / "BirdSongs/Extracted")))
        self.sensor_id = env("SENSOR_ID", "default")
        self.poll = int(env("POLL_INTERVAL", "10"))
        self.min_conf = float(env("MIN_CONFIDENCE", "0.0"))
        self.make_spectrogram = env("MAKE_SPECTROGRAM", "1") == "1"
        self.lat = env("LAT")
        self.lon = env("LON")
        if not self.ingest_url or not self.ingest_token:
            raise SystemExit("INGEST_URL and INGEST_TOKEN are required")


def read_checkpoint() -> int:
    try:
        import json

        return int(json.loads(STATE_PATH.read_text()).get("last_rowid", 0))
    except Exception:
        return 0


def write_checkpoint(rowid: int) -> None:
    import json

    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps({"last_rowid": rowid}))
    tmp.replace(STATE_PATH)


def detection_uuid(cfg: Config, file_name: str, date: str, t: str) -> str:
    return str(uuid.uuid5(_NS, f"{cfg.sensor_id}|{date}|{t}|{file_name}"))


def to_epoch(date: str, t: str) -> int:
    # BirdNET-Pi stores LOCAL date/time; interpret in the Pi's local timezone.
    dt = datetime.strptime(f"{date} {t}", "%Y-%m-%d %H:%M:%S")
    return int(dt.astimezone().timestamp())


def find_clip(cfg: Config, date: str, com_name: str, file_name: str) -> Path | None:
    folder = com_name.replace(" ", "_").replace("'", "")
    candidate = cfg.extracted / "By_Date" / date / folder / file_name
    if candidate.exists():
        return candidate
    # Fallback: glob anywhere under that date for the recorded filename.
    matches = list((cfg.extracted / "By_Date" / date).rglob(file_name))
    return matches[0] if matches else None


def ensure_spectrogram(cfg: Config, clip: Path) -> Path | None:
    png = clip.with_suffix(clip.suffix + ".png")
    if png.exists():
        return png
    sibling = clip.with_suffix(".png")
    if sibling.exists():
        return sibling
    if not cfg.make_spectrogram or shutil.which("sox") is None:
        return None
    try:
        # Compact, axis-free spectrogram suitable for img2img later.
        subprocess.run(
            ["sox", str(clip), "-n", "spectrogram", "-r", "-o", str(png), "-x", "640", "-y", "320"],
            check=True,
            capture_output=True,
            timeout=30,
        )
        return png if png.exists() else None
    except Exception as e:  # noqa: BLE001
        log.warning("spectrogram generation failed for %s: %s", clip.name, e)
        return None


def post_detection(cfg: Config, row: sqlite3.Row) -> bool:
    file_name = row["File_Name"]
    date, t = row["Date"], row["Time"]
    det_id = detection_uuid(cfg, file_name, date, t)

    meta = {
        "id": det_id,
        "ts": to_epoch(date, t),
        "sci_name": row["Sci_Name"],
        "com_name": row["Com_Name"],
        "confidence": float(row["Confidence"]),
        "sensor_id": cfg.sensor_id,
    }
    if "Week" in row.keys() and row["Week"] is not None:
        meta["week"] = int(row["Week"])
    lat = cfg.lat or (row["Lat"] if "Lat" in row.keys() else None)
    lon = cfg.lon or (row["Lon"] if "Lon" in row.keys() else None)
    if lat not in (None, ""):
        meta["lat"] = float(lat)
    if lon not in (None, ""):
        meta["lon"] = float(lon)

    import json

    files: list[tuple[str, tuple[str, object, str]]] = [
        ("meta", (None, json.dumps(meta), "application/json")),  # type: ignore[list-item]
    ]
    opened: list[object] = []

    clip = find_clip(cfg, date, row["Com_Name"], file_name)
    if clip:
        fh = open(clip, "rb")
        opened.append(fh)
        files.append(("clip", (clip.name, fh, "audio/mpeg")))
        png = ensure_spectrogram(cfg, clip)
        if png:
            ph = open(png, "rb")
            opened.append(ph)
            files.append(("spectrogram", (png.name, ph, "image/png")))
    else:
        log.warning("clip not found for %s (%s)", file_name, row["Com_Name"])

    try:
        resp = requests.post(
            cfg.ingest_url,
            headers={"Authorization": f"Bearer {cfg.ingest_token}"},
            files=files,  # type: ignore[arg-type]
            timeout=60,
        )
        if resp.status_code == 200:
            log.info("sent %s %s (conf %.2f)", row["Com_Name"], date + " " + t, meta["confidence"])
            return True
        log.error("ingest %s -> %s: %s", det_id, resp.status_code, resp.text[:200])
        return False
    except requests.RequestException as e:
        log.error("ingest network error: %s", e)
        return False
    finally:
        for fh in opened:
            try:
                fh.close()  # type: ignore[attr-defined]
            except Exception:
                pass


def fetch_new(cfg: Config, after_rowid: int) -> list[sqlite3.Row]:
    if not cfg.db_path.exists():
        log.warning("BirdNET-Pi DB not found at %s (yet?)", cfg.db_path)
        return []
    # Read-only, tolerate concurrent writers.
    con = sqlite3.connect(f"file:{cfg.db_path}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        cur = con.execute(
            "SELECT rowid, * FROM detections WHERE rowid > ? AND Confidence >= ? ORDER BY rowid ASC",
            (after_rowid, cfg.min_conf),
        )
        return cur.fetchall()
    except sqlite3.OperationalError as e:
        log.warning("DB read error: %s", e)
        return []
    finally:
        con.close()


def run(cfg: Config) -> None:
    last = read_checkpoint()
    log.info("forwarder up. db=%s extracted=%s last_rowid=%d", cfg.db_path, cfg.extracted, last)
    backoff = cfg.poll
    while True:
        rows = fetch_new(cfg, last)
        progressed = False
        for row in rows:
            if post_detection(cfg, row):
                last = row["rowid"]
                write_checkpoint(last)
                progressed = True
            else:
                break  # keep ordering; retry this row next loop
        backoff = cfg.poll if (progressed or not rows) else min(backoff * 2, 300)
        time.sleep(backoff)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s", stream=sys.stdout
    )
    cfg = Config()
    if "--once" in sys.argv:
        rows = fetch_new(cfg, read_checkpoint())
        log.info("--once: %d new detections", len(rows))
        for row in rows:
            if post_detection(cfg, row):
                write_checkpoint(row["rowid"])
        return
    run(cfg)


if __name__ == "__main__":
    main()
