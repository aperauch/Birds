#!/usr/bin/env python3
"""
Scrape the best eBird / Macaulay Library photos for a species and feed them to
the Birds edge Worker.

WHY THIS EXISTS
---------------
eBird (ebird.org) hosts the highest-quality, expertly-reviewed bird photos via
the Cornell Lab's Macaulay Library. But the Macaulay *search* API
(search.macaulaylibrary.org / media.ebird.org /api/v2/search) is bot-protected:
plain `fetch()`/`curl` get HTTP 403 (a JS challenge sets a `_1ddeb` cookie), and
the ebird.org/species/<code> pages now require login. The Macaulay *asset image
CDN* (cdn.download.ams.birds.cornell.edu/api/v2/asset/<id>/<size>) is open, so
all we need is each species' top asset IDs.

This script drives a real Chromium via Playwright in STEALTH mode, which runs the
JS bot-challenge like a human browser. It loads the public Macaulay catalog for a
species' eBird code, captures the in-page search XHR (falling back to scraping
`/asset/<id>` links from the DOM), and extracts the top photos' asset IDs +
photographer credits.

It then POSTs the results to the Worker's `POST /admin/macaulay` endpoint, which
stores them in KV (consumed by the species modal) and upgrades the collage tile
photo in R2. The Worker rebuilds the asset-CDN URL from the asset id itself, so we
only send ids + credits.

USAGE
-----
    # one species by eBird code (+ scientific name so the collage tile updates)
    python scrape.py --code amerob --sci "Turdus migratorius" \
        --api-base https://birds.aperauch.com --token "$INGEST_TOKEN" --push

    # every species the live site knows about (reads /api/species for codes)
    python scrape.py --all \
        --api-base https://birds.aperauch.com --token "$INGEST_TOKEN" --push

    # dry run: scrape and print JSON, don't push
    python scrape.py --code amerob --out -

See README.md for setup (venv + `playwright install chromium`).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass, asdict
from typing import Any
from urllib.parse import urlencode

import requests
from playwright.async_api import async_playwright, Browser, Page

CATALOG_BASE = "https://media.ebird.org/catalog"
ASSET_RE = re.compile(r"/asset/(\d+)")
DEFAULT_MAX = 12
NAV_TIMEOUT_MS = 60_000

# The Macaulay catalog is a Nuxt SPA that server-renders its results into
# `window.__NUXT__` (no client search XHR fires). The browser resolves that
# payload into a real object graph, so we read it directly and pull every record
# carrying an `assetId` + `userDisplayName`. Array order follows eBird's
# requested `rating_rank_desc` sort, so we preserve it (do NOT re-sort by raw
# rating — eBird's rank blends rating with the number of ratings).
NUXT_EXTRACT_JS = r"""
() => {
  const out = [];
  const seen = new Set();
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 9 || out.length >= 60) return;
    if (Array.isArray(o)) { for (const x of o) visit(x, depth + 1); return; }
    if ('assetId' in o && ('userDisplayName' in o || 'taxonomy' in o)) {
      const id = String(o.assetId == null ? '' : o.assetId);
      if (/^\d+$/.test(id) && !seen.has(id)) {
        seen.add(id);
        out.push({ assetId: id, user: o.userDisplayName || null });
      }
    }
    for (const k in o) { try { visit(o[k], depth + 1); } catch (e) {} }
  };
  try { visit(window.__NUXT__, 0); } catch (e) {}
  return out;
};
"""

# A current desktop-Chrome UA on macOS. Keep the major version recent.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Manual stealth evasions injected before any page script runs. Version-proof and
# independent of the optional `playwright-stealth` package — these remove the most
# common headless/automation tells (navigator.webdriver, missing plugins, the
# chrome runtime object, permissions quirks, and a generic WebGL vendor/renderer).
STEALTH_JS = r"""
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
window.chrome = window.chrome || { runtime: {} };
const _query = window.navigator.permissions && window.navigator.permissions.query;
if (_query) {
  window.navigator.permissions.query = (p) =>
    p && p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : _query(p);
}
try {
  const gp = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
    if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return gp.call(this, p);
  };
} catch (e) {}
"""


@dataclass
class Photo:
    assetId: str
    label: str
    credit: str


def catalog_url(code: str) -> str:
    qs = urlencode({"taxonCode": code, "sort": "rating_rank_desc", "mediaType": "photo"})
    return f"{CATALOG_BASE}?{qs}"


def credit_for(name: str | None) -> str:
    who = re.sub(r"\s+", " ", (name or "").strip())
    return f"\u00a9 {who or 'Unknown'} / Macaulay Library"


def items_to_photos(items: list[dict[str, Any]], max_photos: int) -> list[Photo]:
    out: list[Photo] = []
    seen: set[str] = set()
    for it in items:
        raw = it.get("assetId", it.get("catalogId"))
        if raw is None:
            continue
        media = str(it.get("mediaType", "")).lower()
        if media and not re.search(r"photo|image|^p$", media):
            continue
        asset_id = str(raw)
        if not asset_id.isdigit() or asset_id in seen:
            continue
        seen.add(asset_id)
        label = re.sub(r"\s+", " ", str(it.get("ageSex", "")).strip())
        out.append(Photo(assetId=asset_id, label=label, credit=credit_for(it.get("userDisplayName"))))
        if len(out) >= max_photos:
            break
    return out


async def apply_optional_stealth(page: Page) -> str | None:
    """Best-effort: layer the `playwright-stealth` package on top of our manual
    evasions if it's installed (its API has changed across versions, so try a
    couple of shapes). Returns the variant used, or None."""
    try:
        from playwright_stealth import stealth_async  # type: ignore

        await stealth_async(page)
        return "playwright-stealth(stealth_async)"
    except Exception:
        pass
    try:
        from playwright_stealth import Stealth  # type: ignore

        applied = Stealth()
        if hasattr(applied, "apply_stealth_async"):
            await applied.apply_stealth_async(page)  # type: ignore[attr-defined]
            return "playwright-stealth(Stealth.apply_stealth_async)"
    except Exception:
        pass
    return None


async def scrape_code(
    browser: Browser,
    code: str,
    max_photos: int,
    debug: bool = False,
) -> list[Photo]:
    context = await browser.new_context(
        user_agent=USER_AGENT,
        locale="en-US",
        timezone_id="America/New_York",
        viewport={"width": 1366, "height": 900},
    )
    await context.add_init_script(STEALTH_JS)
    page = await context.new_page()
    used = await apply_optional_stealth(page)
    if debug and used:
        print(f"[{code}] stealth layer: {used}", file=sys.stderr)

    try:
        await page.goto(catalog_url(code), wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        try:
            await page.wait_for_load_state("networkidle", timeout=20_000)
        except Exception:
            pass
        await page.wait_for_timeout(1200)

        # Primary: structured records (asset id + photographer) from the resolved
        # Nuxt payload.
        items: list[dict[str, Any]] = []
        try:
            records = await page.evaluate(NUXT_EXTRACT_JS)
        except Exception as e:
            records = []
            if debug:
                print(f"[{code}] nuxt extract error: {e}", file=sys.stderr)
        if isinstance(records, list):
            for r in records:
                items.append({"assetId": r.get("assetId"), "userDisplayName": r.get("user")})
        photos = items_to_photos(items, max_photos)
        if debug:
            print(
                f"[{code}] nuxt records: {len(items)}; photos: {len(photos)}",
                file=sys.stderr,
            )

        # Fallback: pull asset ids straight off the rendered cards (no credits).
        if not photos:
            hrefs = await page.eval_on_selector_all(
                'a[href*="/asset/"], img[src*="/asset/"]',
                "els => els.map(e => e.getAttribute('href') || e.getAttribute('src') || '')",
            )
            ids: list[str] = []
            for h in hrefs:
                m = ASSET_RE.search(h or "")
                if m and m.group(1) not in ids:
                    ids.append(m.group(1))
            photos = items_to_photos([{"assetId": i} for i in ids], max_photos)
            if debug:
                print(f"[{code}] DOM fallback ids: {len(ids)}; photos: {len(photos)}", file=sys.stderr)

        if debug and not photos:
            html = await page.content()
            blocked = "Forbidden" in html or "captcha" in html.lower()
            print(f"[{code}] NO PHOTOS (looks blocked={blocked}; html {len(html)}b)", file=sys.stderr)
        return photos
    finally:
        await context.close()


def fetch_species(api_base: str) -> list[dict[str, str]]:
    """Read the live /api/species and return [{sci_name, code}] for species that
    already have a resolved eBird code (ebird_url ends in /species/<code>)."""
    res = requests.get(f"{api_base.rstrip('/')}/api/species", timeout=30)
    res.raise_for_status()
    out: list[dict[str, str]] = []
    for s in res.json().get("species", []):
        url = s.get("ebird_url") or ""
        m = re.search(r"/species/([a-z0-9]+)", url)
        if m:
            out.append({"sci_name": s.get("sci_name", ""), "code": m.group(1)})
    return out


def push(api_base: str, token: str, code: str, sci_name: str | None, photos: list[Photo]) -> dict[str, Any]:
    body: dict[str, Any] = {"code": code, "photos": [asdict(p) for p in photos]}
    if sci_name:
        body["sci_name"] = sci_name
    res = requests.post(
        f"{api_base.rstrip('/')}/admin/macaulay",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    if res.status_code >= 300:
        raise RuntimeError(f"push {code} -> {res.status_code}: {res.text[:200]}")
    return res.json()


async def run(args: argparse.Namespace) -> int:
    # Build the work list: (code, sci_name|None).
    targets: list[tuple[str, str | None]] = []
    if args.all:
        if not args.api_base:
            print("--all requires --api-base", file=sys.stderr)
            return 2
        for s in fetch_species(args.api_base):
            targets.append((s["code"], s["sci_name"] or None))
        print(f"{len(targets)} species with eBird codes from {args.api_base}", file=sys.stderr)
    for code in args.code or []:
        targets.append((code.lower(), args.sci))
    if not targets:
        print("nothing to do: pass --code CODE or --all", file=sys.stderr)
        return 2

    token = args.token or os.environ.get("INGEST_TOKEN") or ""
    if args.push and not token:
        print("--push requires --token or INGEST_TOKEN", file=sys.stderr)
        return 2

    results: list[dict[str, Any]] = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=not args.headful,
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            for code, sci in targets:
                try:
                    photos = await scrape_code(browser, code, args.max, debug=args.debug)
                except Exception as e:  # one species failing must not abort the run
                    print(f"[{code}] scrape failed: {e}", file=sys.stderr)
                    photos = []
                rec = {
                    "code": code,
                    "sci_name": sci,
                    "photos": [asdict(p) for p in photos],
                }
                results.append(rec)
                status = f"{len(photos)} photos"
                if args.push:
                    try:
                        pr = push(args.api_base, token, code, sci, photos)
                        status += f" -> pushed (collage_key={pr.get('collage_key')})"
                    except Exception as e:
                        status += f" -> PUSH FAILED: {e}"
                print(f"[{code}] {sci or ''} {status}", file=sys.stderr)
                if len(targets) > 1:
                    time.sleep(args.delay)
        finally:
            await browser.close()

    if args.out:
        payload = json.dumps(results, indent=2, ensure_ascii=False)
        if args.out == "-":
            print(payload)
        else:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(payload)
            print(f"wrote {args.out}", file=sys.stderr)

    found = sum(1 for r in results if r["photos"])
    print(f"done: {found}/{len(results)} species with photos", file=sys.stderr)
    return 0 if found else 1


def main() -> int:
    p = argparse.ArgumentParser(description="Scrape eBird/Macaulay photos via Playwright stealth.")
    p.add_argument("--code", action="append", help="eBird species code (repeatable), e.g. amerob")
    p.add_argument("--sci", help="scientific name to pair with a single --code (enables collage update)")
    p.add_argument("--all", action="store_true", help="scrape every species from <api-base>/api/species")
    p.add_argument("--api-base", default=os.environ.get("BIRDS_API_BASE", "https://birds.aperauch.com"))
    p.add_argument("--token", help="INGEST_TOKEN for the admin endpoint (or set INGEST_TOKEN env)")
    p.add_argument("--push", action="store_true", help="POST results to <api-base>/admin/macaulay")
    p.add_argument("--out", help='write results JSON to FILE, or "-" for stdout')
    p.add_argument("--max", type=int, default=DEFAULT_MAX, help=f"max photos per species (default {DEFAULT_MAX})")
    p.add_argument("--delay", type=float, default=1.5, help="seconds between species in --all/multi mode")
    p.add_argument("--headful", action="store_true", help="show the browser window (more reliable bypass)")
    p.add_argument("--debug", action="store_true", help="verbose diagnostics to stderr")
    args = p.parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
