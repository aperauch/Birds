// Phase 6 — notifications for new & rare species.
//
// Two independently-toggleable channels, both no-op when their config is unset:
//   - ntfy:     POST to a configurable ntfy.sh topic (NTFY_TOPIC).
//   - Web Push: VAPID-authenticated, aes128gcm-encrypted push (RFC 8291/8188)
//               to subscriptions stored in D1. Enabled when VAPID_* are set.
//
// A per-species throttle in KV suppresses repeats within a window.
import type { Bindings, DetectionEvent } from "./types";

const THROTTLE_SEC = 30 * 60; // at most one alert per species per 30 min

// --- base64url helpers ------------------------------------------------------
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// --- VAPID (ES256 JWT) ------------------------------------------------------
async function importVapidSigningKey(env: Bindings): Promise<CryptoKey> {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY); // 65 bytes: 0x04 || X || Y
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: env.VAPID_PRIVATE_KEY,
    x: bytesToB64url(pub.subarray(1, 33)),
    y: bytesToB64url(pub.subarray(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function vapidAuthHeader(env: Bindings, audience: string): Promise<string> {
  const enc = new TextEncoder();
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(
    enc.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await importVapidSigningKey(env);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)),
  );
  const jwt = `${signingInput}.${bytesToB64url(sig)}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// --- payload encryption (RFC 8291 + aes128gcm RFC 8188) --------------------
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

interface EncryptedPush {
  body: Uint8Array;
}

async function encryptPayload(
  plaintext: Uint8Array,
  clientP256dh: Uint8Array,
  clientAuth: Uint8Array,
): Promise<EncryptedPush> {
  const enc = new TextEncoder();
  // Ephemeral (server) ECDH keypair.
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer,
  ); // 65 bytes
  const uaPublic = clientP256dh;

  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientP256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // workerd's generated types name the peer key field differently; the runtime
  // expects `public`, so build the algorithm untyped.
  const ecdhAlg = { name: "ECDH", public: clientKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhAlg, eph.privateKey, 256));

  // RFC 8291: derive the IKM from the ECDH secret + auth secret.
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(clientAuth, ecdh, keyInfo, 32);

  // RFC 8188 aes128gcm content encryption.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // Single record: plaintext || 0x02 delimiter (last record).
  const record = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
  );

  // Header: salt(16) || rs(4 big-endian) || idlen(1) || keyid(asPublic, 65).
  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096
  const idlen = new Uint8Array([asPublic.length]);
  const body = concat(salt, rs, idlen, asPublic, ciphertext);
  return { body };
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

async function sendOne(env: Bindings, sub: SubRow, payload: PushPayload): Promise<void> {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const auth = await vapidAuthHeader(env, audience);
  const { body } = await encryptPayload(
    new TextEncoder().encode(JSON.stringify(payload)),
    b64urlToBytes(sub.p256dh),
    b64urlToBytes(sub.auth),
  );

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });

  // Prune dead subscriptions.
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
      .bind(sub.endpoint)
      .run();
  } else if (!res.ok) {
    console.error(`web push -> ${res.status} ${await res.text().catch(() => "")}`);
  }
}

function webPushEnabled(env: Bindings): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

async function sendWebPushAll(env: Bindings, payload: PushPayload): Promise<void> {
  if (!webPushEnabled(env)) return;
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions",
  ).all<SubRow>();
  await Promise.all((results ?? []).map((s) => sendOne(env, s, payload).catch((e) => console.error("push", e))));
}

/**
 * Diagnostic: send a test push to every stored subscription and return the
 * raw push-service HTTP status per subscription. Used by POST /admin/push-test
 * to verify VAPID + payload encryption end to end.
 */
export async function sendTestPush(
  env: Bindings,
): Promise<{ enabled: boolean; subs: number; results: { ep: string; status: number; error?: string }[] }> {
  if (!webPushEnabled(env)) return { enabled: false, subs: 0, results: [] };
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions",
  ).all<SubRow>();
  const payload: PushPayload = {
    title: "🐦 Test alert",
    body: "If you can read this, push notifications are working.",
    url: env.PUBLIC_BASE_URL || "/",
    tag: "test",
  };
  const out: { ep: string; status: number; error?: string }[] = [];
  for (const sub of results ?? []) {
    try {
      const url = new URL(sub.endpoint);
      const auth = await vapidAuthHeader(env, `${url.protocol}//${url.host}`);
      const { body } = await encryptPayload(
        new TextEncoder().encode(JSON.stringify(payload)),
        b64urlToBytes(sub.p256dh),
        b64urlToBytes(sub.auth),
      );
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "86400",
          Urgency: "high",
        },
        body,
      });
      out.push({
        ep: sub.endpoint.slice(0, 36),
        status: res.status,
        error: res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 200),
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
          .bind(sub.endpoint)
          .run();
      }
    } catch (e) {
      out.push({ ep: sub.endpoint.slice(0, 36), status: 0, error: String((e as Error).message) });
    }
  }
  return { enabled: true, subs: (results ?? []).length, results: out };
}

async function sendNtfy(env: Bindings, payload: PushPayload): Promise<void> {
  if (!env.NTFY_TOPIC) return;
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      Title: payload.title,
      Tags: "bird",
      ...(payload.url ? { Click: payload.url } : {}),
    },
    body: payload.body,
  }).catch((e) => console.error("ntfy", e));
}

/**
 * Fire notifications for a new or rare detection across all enabled channels,
 * throttled to one alert per species per window. Safe to call in waitUntil.
 */
export async function notifyDetection(env: Bindings, event: DetectionEvent): Promise<void> {
  if (!event.is_new_species && !event.is_rare) return;
  if (!env.NTFY_TOPIC && !webPushEnabled(env)) return;

  // Throttle per species (skip if we alerted recently).
  const throttleKey = `notify:${event.sci_name}`;
  if (await env.CACHE.get(throttleKey)) return;
  await env.CACHE.put(throttleKey, String(event.ts), { expirationTtl: THROTTLE_SEC });

  const kind = event.is_new_species ? "New species" : "Rare visitor";
  const payload: PushPayload = {
    title: `${kind}: ${event.com_name}`,
    body: `${event.com_name} just heard (${Math.round(event.confidence * 100)}% confidence).`,
    url: env.PUBLIC_BASE_URL,
    tag: event.sci_name,
  };

  await Promise.all([sendNtfy(env, payload), sendWebPushAll(env, payload)]);
}
