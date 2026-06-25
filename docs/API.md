# Birds read API

Base URL: **https://birds.aperauch.com**

All read endpoints are public (no auth). Write/admin endpoints require
`Authorization: Bearer ${INGEST_TOKEN}` and are documented in
[`../infra/DEPLOYED.md`](../infra/DEPLOYED.md).

Responses are JSON unless noted. Analytics endpoints set `Cache-Control:
public, max-age=60`.

---

## Live & detections

### `GET /api/recent?limit=30`

Most-recent detections (max 100). Served from the Aviary DO hot buffer when
possible, otherwise D1.

```bash
curl -s "https://birds.aperauch.com/api/recent?limit=10"
```

### `GET /api/detections?from=&to=&limit=2000`

Detections in a time window (`from`/`to` are unix seconds; default last 24h,
limit max 5000).

```bash
curl -s "https://birds.aperauch.com/api/detections?from=1700000000&to=1700086400"
```

### `GET /ws`

WebSocket live feed. On connect the server sends `{type:"hello",recent:[…]}`,
then `{type:"detection",event:{…}}` per new detection. Send `"ping"` to keep
the connection warm (server replies `{type:"ping",ts}`).

---

## Species & art

### `GET /api/species`

All species ever detected, with cached art URLs (`photo_url`,
`flux_perched_url`, `flux_flight_url`, `flux_perched_cut_url`,
`flux_flight_cut_url`, `wikipedia_url`).

### `GET /api/species/:sci`

One species (URL-encode the scientific name) plus its 20 most recent
detections.

```bash
curl -s "https://birds.aperauch.com/api/species/Corvus%20brachyrhynchos"
```

### `GET /api/masks`

Silhouette masks for shape-aware collage packing, grouped by species slug:

```json
{ "masks": { "corvus-brachyrhynchos": { "perched": { "w": 96, "h": 84, "bits": "<base64>" } } } }
```

`bits` is a base64-packed, MSB-first, row-major 1-bit alpha mask of size `w*h`.

---

## Analytics (Phase 4)

### `GET /api/stats`

Top-line totals + top species in the last 24h.

### `GET /api/stats/daily?days=30`

Per-day totals (`daily`), aggregate `top_species`, and the raw per-species
`series`. `days` is clamped to 1..365.

```bash
curl -s "https://birds.aperauch.com/api/stats/daily?days=14"
```

### `GET /api/stats/hourly?date=YYYY-MM-DD`

Dawn-chorus histogram: a 24-element `hours` array of detection counts by
hour-of-day (UTC) for the given date (default today).

```bash
curl -s "https://birds.aperauch.com/api/stats/hourly?date=2026-04-16"
```

### `GET /api/stats/richness?days=30`

Distinct species per day (`richness: [{date, species}]`).

### `GET /api/export.csv?from=&to=`

Streamed CSV of detections in a window (`from`/`to` unix seconds; default last
30 days). Columns: `id,ts,iso_time,sci_name,com_name,confidence,week,sensor_id`.

```bash
curl -s "https://birds.aperauch.com/api/export.csv?from=1700000000&to=1700600000" -o birds.csv
```

---

## Media

### `GET /media/<r2-key>`

R2-backed media (clips, spectrograms, art). Immutable, long-cached. The
`frame/` prefix additionally requires `?k=<FRAME_KEY>` (Phase 5).
