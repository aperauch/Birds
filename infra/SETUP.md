# Provisioning & deploy runbook (edge)

One-time setup of the Cloudflare resources, then deploy. Run from `edge/`.

Prereqs: the zone **aperauch.com** is active on this Cloudflare account, and
`wrangler` is authenticated:

```bash
cd edge
npm install
npx wrangler login
```

## 1. Create the stateful resources

```bash
# D1 database — copy the printed database_id into wrangler.jsonc (d1_databases[0].database_id)
npx wrangler d1 create birds

# KV namespace — copy the printed id into wrangler.jsonc (kv_namespaces[0].id)
npx wrangler kv namespace create CACHE

# R2 bucket for clips / spectrograms / art / frame PNGs
npx wrangler r2 bucket create birds-media

# Queues (art generation + dead-letter)
npx wrangler queues create birds-art
npx wrangler queues create birds-art-dlq
```

Edit `wrangler.jsonc` and replace the two `PLACEHOLDER_*` ids with the values
printed above.

## 2. Apply the database schema

```bash
npx wrangler d1 migrations apply birds --remote
```

## 3. Set the ingest secret

Generate a strong token and store it as a Worker secret. Use the **same value**
in the Pi's `/etc/birds-forwarder.env` (`INGEST_TOKEN`).

```bash
openssl rand -hex 32            # copy this
npx wrangler secret put INGEST_TOKEN
```

## 4. Deploy

```bash
# build the dashboard first once Phase 2 exists; a placeholder ships meanwhile
npx wrangler deploy
```

On deploy, the `routes` entry provisions **birds.aperauch.com** as a custom
domain on the Worker (the zone must already be on this account).

## 5. Verify

```bash
curl https://birds.aperauch.com/healthz
# {"ok":true,"service":"birds-edge"}

# simulate a detection (no clip) to exercise ingest -> D1 -> DO broadcast:
curl -X POST https://birds.aperauch.com/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -F 'meta={"id":"test-1","ts":'"$(date +%s)"',"sci_name":"Corvus brachyrhynchos","com_name":"American Crow","confidence":0.91}'

curl https://birds.aperauch.com/api/recent
curl https://birds.aperauch.com/api/stats
```

Then point the Pi forwarder at `https://birds.aperauch.com/ingest` and start the
service (see [`sensor/README.md`](../sensor/README.md)).

## Local development

```bash
npx wrangler d1 migrations apply birds --local
npx wrangler dev          # http://localhost:8787
```

`wrangler dev` runs D1/R2/KV/Queues/DO locally. Workers AI + Browser Rendering
proxy to the real services. Set a local `INGEST_TOKEN` in `.dev.vars`.

## Bindings reference

| Binding | Resource | Used for |
|--------|----------|----------|
| `DB` | D1 `birds` | detections, species, art_assets |
| `MEDIA` | R2 `birds-media` | clips, spectrograms, art, frame PNGs |
| `CACHE` | KV | hot lookups / dedupe (Phase 3) |
| `ART_QUEUE` | Queue `birds-art` | async art generation jobs |
| `AVIARY` | Durable Object | live state + WebSocket fan-out |
| `AI` | Workers AI | FLUX / SDXL art (Phase 3) |
| `BROWSER` | Browser Rendering | frame PNG render (Phase 5) |
| `ASSETS` | Workers Assets | dashboard SPA (Phase 2) |
| `INGEST_TOKEN` | secret | authenticates the sensor |
