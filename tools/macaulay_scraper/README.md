# Macaulay photo scraper

Scrapes the best eBird / [Macaulay Library](https://www.macaulaylibrary.org/) photos
for each species and feeds them to the Birds edge Worker.

## Why a local scraper (and not the Worker)?

eBird hosts the highest-quality, expertly-reviewed bird photos, but its **search**
API is bot-protected — plain `fetch()`/`curl` get **HTTP 403** (a JS challenge
sets a `_1ddeb` cookie) and `ebird.org/species/<code>` pages now require login.
The Macaulay **asset image CDN** (`cdn.download.ams.birds.cornell.edu/api/v1/asset/<id>`,
AWS CloudFront) is open, so all we need is each species' top **asset ids**.

This tool drives a real Chromium via **Playwright in stealth mode**, which runs the
JS bot-challenge like a human browser, loads the public Macaulay catalog for a
species' eBird code, captures the in-page search XHR (with a DOM fallback), and
extracts the top photos' asset ids + photographer credits. It then POSTs them to
the Worker's `POST /admin/macaulay`, which caches them in KV (species modal) and
mirrors the top photo into R2 (collage tile). The Worker rebuilds the asset-CDN
URL from the id, so only ids + credits are sent.

## Setup

```sh
cd tools/macaulay_scraper
python3.13 -m venv .venv            # 3.13 or 3.14 both work
.venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium
```

## Usage

```sh
# Dry run — scrape one species and print JSON (no push):
.venv/bin/python scrape.py --code amerob --out -

# Scrape one species and push (updates modal + collage tile):
.venv/bin/python scrape.py --code amerob --sci "Turdus migratorius" \
  --api-base https://birds.aperauch.com --token "$INGEST_TOKEN" --push

# Scrape EVERY species the live site knows about (reads /api/species for codes):
.venv/bin/python scrape.py --all \
  --api-base https://birds.aperauch.com --token "$INGEST_TOKEN" --push

# Troubleshoot a stubborn species (visible browser + diagnostics):
.venv/bin/python scrape.py --code amerob --headful --debug --out -
```

`INGEST_TOKEN` is the same secret the sensor uses (`wrangler secret list` on the
edge Worker). It can be passed via `--token` or the `INGEST_TOKEN` env var.

### Flags

| flag | purpose |
|---|---|
| `--code CODE` | eBird species code (repeatable), e.g. `amerob` |
| `--sci NAME` | scientific name to pair with a single `--code` (enables the collage-tile update) |
| `--all` | scrape every species from `<api-base>/api/species` |
| `--api-base URL` | Worker base URL (default `https://birds.aperauch.com`, or `$BIRDS_API_BASE`) |
| `--token TOK` | `INGEST_TOKEN` for `POST /admin/macaulay` |
| `--push` | actually POST results to the Worker |
| `--out FILE` | write results JSON to `FILE`, or `-` for stdout |
| `--max N` | max photos per species (default 12) |
| `--headful` | show the browser window (most reliable bypass) |
| `--debug` | verbose diagnostics to stderr |

## Keeping photos fresh

Run `--all --push` on a schedule (cron / launchd) — e.g. weekly — to pick up new
species and refreshed top photos. The Worker caches ingested photos in KV for 30
days; re-pushing refreshes them.

## Notes

- A `playwright-stealth` package, if installed, is layered on top of the built-in
  manual evasions; the scraper works fine without it.
- If a species returns no photos, retry with `--headful --debug`. Headless is
  occasionally challenged where a visible browser is not.
