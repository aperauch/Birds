# Deployed state (production)

Account: **Aperauch** (`[redacted]`)
Zone: **aperauch.com** (`2e4db964aed0ff2b29d68e57f3f373e1`, Enterprise)
Worker: **birds-edge** → https://birds.aperauch.com

## Resource IDs (already wired into wrangler.jsonc)

| Resource | Name | ID |
|----------|------|-----|
| D1 | `birds` | `3c15ce21-eebe-4dbc-bf28-711d0fe1c461` |
| KV | `birds-cache` | `b7938b18199a4625b24a1f93b0b48476` |
| R2 | `birds-media` | — |
| Queue | `birds-art` | `202d80e5c8cf4a28b2c9875ed573dd48` |
| Queue (DLQ) | `birds-art-dlq` | `404f75faffab48848ef1d24234f1631f` |

## Secret

`INGEST_TOKEN` is set on the Worker. The plaintext is stored locally (gitignored)
at `infra/ingest-token.local` — copy it into the Pi's `/etc/birds-forwarder.env`.

## WAF note (important)

The `aperauch.com` zone's **managed WAF** flagged the multipart `/ingest` POST as a
SQLi-like payload and blocked it. A scoped skip rule was added at the **top** of the
zone's `http_request_firewall_custom` ruleset (id `8dfbf34fadd54c149938de1d80006de4`):

- expression: `(http.request.uri.path eq "/ingest" and http.request.method eq "POST")`
- action: `skip` → managed WAF + rate limiting + remaining custom rules + security products

`/ingest` is still protected by the bearer `INGEST_TOKEN` at the application layer.
If ingest ever starts returning a Cloudflare HTML block page, re-check this rule.

## Operational endpoints

- `GET  /healthz` — liveness
- `POST /ingest` — sensor ingest (Bearer `INGEST_TOKEN`, multipart: meta+clip+spectrogram)
- `POST /admin/reset` — wipe all detections/species/art + live buffer (Bearer `INGEST_TOKEN`)
- `GET  /api/recent|detections|species|species/:sci|stats`
- `GET  /ws` — live WebSocket feed
- `GET  /media/*` — R2-backed media

## Queue tuning

`birds-art` consumer: `max_batch_size=5`, `max_batch_timeout=5s`, `max_retries=3`,
DLQ `birds-art-dlq`. (A single detection's art now lands within ~5s.)

## Redeploy

```bash
cd web && npm run build && cd ../edge && npx wrangler deploy
```
