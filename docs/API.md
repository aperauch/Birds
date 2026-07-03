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

> **Note:** `docs/PLAN.md` describes a future `GET /api/masks` (silhouette
> masks for shape-aware collage packing) as part of Phase 3.5b. It has not
> been built — the route does not exist, and the collage instead falls back to
> rectangular tiles with a transparent-cutout background image where available.

---

## Analytics

Unless noted, `days` is clamped 1..365 and the endpoint sets `Cache-Control:
public, max-age=60..120`. "Eastern" below means US Eastern local time
(DST-aware, computed server-side — see `edge/src/tz.ts`); everything else
(`daily`, `richness`, the calendar/day-of-week views built from them) buckets
by **UTC** calendar date, inherited from the `daily_stats` rollup table.

### `GET /api/stats`

Top-line totals + top species in the last 24h.

### `GET /api/stats/daily?days=30`

Per-day totals (`daily`, UTC dates), aggregate `top_species`, and the raw
per-species-per-day `series` (every `daily_stats` row in range — the raw
material behind the client-side sparklines/streaks/diversity analytics).

```bash
curl -s "https://birds.aperauch.com/api/stats/daily?days=14"
```

### `GET /api/stats/hourly?date=YYYY-MM-DD`

Dawn-chorus histogram: a 24-element `hours` array of detection counts by
**Eastern** hour-of-day for the given UTC calendar date (default today).

```bash
curl -s "https://birds.aperauch.com/api/stats/hourly?date=2026-04-16"
```

### `GET /api/stats/diel?days=30&limit=12`

Per-species call counts by Eastern hour-of-day (`species: [{sci_name,
com_name, total, hours[24]}]`, plus a grand `total[24]`). Species beyond
`limit` (max 30) fold into an `"Other species"` row (`sci_name: ""`). Powers
the diel heatmap and the stacked calls-by-hour chart.

### `GET /api/stats/punchcard?days=30`

Weekday x Eastern-hour call counts: `matrix[dow][hour]`, a 7x24 grid where
`dow` follows SQLite's `%w` (`0`=Sunday .. `6`=Saturday).

```bash
curl -s "https://birds.aperauch.com/api/stats/punchcard?days=30"
```

### `GET /api/stats/firstlast?days=60`

Per Eastern-date first/last detection instant (`items: [{date, first_ts,
last_ts}]`) — the dawn-chorus-onset chart. When the Worker has `SITE_LAT` /
`SITE_LON` secrets configured, also includes `sun: [{date, sunrise,
sunset}]` (computed server-side via `edge/src/sun.ts`; the coordinates
themselves are never returned, only the derived sunrise/sunset instants).

```bash
curl -s "https://birds.aperauch.com/api/stats/firstlast?days=30"
```

### `GET /api/stats/cooccurrence?days=30&limit=10&bucket=600`

Which of the top `limit` species (max 16) are detected within the same
`bucket`-second time window (default 10 min). Returns `species: [{sci_name,
com_name, buckets}]` (the diagonal — active-bucket counts) and `pairs:
[{s1, s2, n}]`.

### `GET /api/stats/anomalies?days=30&rareDays=30`

Notable species for the range: `type` is `"new"` (first seen in range),
`"returned"` (absent more than `rareDays` days then seen again), or
`"uncommon"` (seen on very few days / very few calls). Derived purely from
this site's own history.

### `GET /api/aggregate?from=&to=`

Compact per-species rollup for a window (`species: [{sci_name, com_name,
count, last_ts, best_confidence}]`) — the payload that powers the
collage/cards/list views (default window: last 24h).

### `GET /api/stats/richness?days=30`

Distinct species per day (`richness: [{date, species}]`, UTC dates).

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
