-- Phase 6: Web Push (VAPID) subscriptions for new/rare species alerts.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,   -- push service endpoint URL
  p256dh     TEXT NOT NULL,      -- client public key (base64url)
  auth       TEXT NOT NULL,      -- client auth secret (base64url)
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
