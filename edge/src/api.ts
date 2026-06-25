// Public read API consumed by the dashboard SPA and the frame renderer.
import { Hono } from "hono";
import type { Bindings, DetectionRow, SpeciesRow } from "./types";
import { aggregateWindow, detectionsInWindow, getSpecies, listSpecies, recentDetections } from "./db";
import { mediaUrl } from "./media";
import { ebirdUrl, resolveEbirdCode } from "./ebird";
import { getCubInfo, type PlumagePhoto } from "./plumage";
import { getCachedMacaulay } from "./macaulay";
import { easternHourSql } from "./tz";

export const api = new Hono<{ Bindings: Bindings }>();

function enrichDetection(env: Bindings, d: DetectionRow) {
  return {
    id: d.id,
    ts: d.ts,
    sci_name: d.sci_name,
    com_name: d.com_name,
    confidence: d.confidence,
    clip_url: mediaUrl(env, d.clip_key),
    spectrogram_url: mediaUrl(env, d.spectrogram_key),
    art_url: mediaUrl(env, d.art_key),
  };
}

function enrichSpecies(env: Bindings, s: SpeciesRow) {
  return {
    sci_name: s.sci_name,
    com_name: s.com_name,
    first_seen: s.first_seen,
    last_seen: s.last_seen,
    total_count: s.total_count,
    best_confidence: s.best_confidence,
    photo_url: mediaUrl(env, s.photo_key),
    flux_perched_url: mediaUrl(env, s.flux_perched_key),
    flux_flight_url: mediaUrl(env, s.flux_flight_key),
    flux_perched_cut_url: mediaUrl(env, s.flux_perched_cut_key),
    flux_flight_cut_url: mediaUrl(env, s.flux_flight_cut_key),
    wikipedia_url: s.wikipedia_url,
    ebird_url: ebirdUrl(s.ebird_code),
  };
}

// Live-ish recent feed. Reads the Aviary DO hot buffer first, falls back to D1.
api.get("/recent", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "30"), 100);
  // Short edge/browser cache to coalesce repeat polls without staling the feed.
  c.header("Cache-Control", "public, max-age=5");
  const aviary = c.env.AVIARY.get(c.env.AVIARY.idFromName("global"));
  const recent = await aviary.getRecent();
  if (recent.length >= limit) {
    return c.json({ detections: recent.slice(0, limit) });
  }
  const rows = await recentDetections(c.env.DB, limit);
  return c.json({ detections: rows.map((d) => enrichDetection(c.env, d)) });
});

// Per-species aggregates for a window — the compact payload that powers the
// collage/cards/list (replaces shipping thousands of raw detection rows).
api.get("/aggregate", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const to = Number(c.req.query("to") ?? now);
  const from = Number(c.req.query("from") ?? to - 86400);
  const species = await aggregateWindow(c.env.DB, from, to);
  c.header("Cache-Control", "public, max-age=20");
  return c.json({ from, to, species });
});

// Window query powering the timeline scrubber.
api.get("/detections", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const to = Number(c.req.query("to") ?? now);
  const from = Number(c.req.query("from") ?? to - 86400);
  const limit = Math.min(Number(c.req.query("limit") ?? "2000"), 5000);
  const rows = await detectionsInWindow(c.env.DB, from, to, limit);
  return c.json({
    from,
    to,
    count: rows.length,
    detections: rows.map((d) => enrichDetection(c.env, d)),
  });
});

api.get("/species", async (c) => {
  const rows = await listSpecies(c.env.DB);
  c.header("Cache-Control", "public, max-age=30");
  return c.json({ species: rows.map((s) => enrichSpecies(c.env, s)) });
});

api.get("/species/:sci", async (c) => {
  const sci = c.req.param("sci");
  const s = await getSpecies(c.env.DB, sci);
  if (!s) return c.json({ error: "not found" }, 404);
  // Lazily backfill the eBird code the first time a species detail is opened
  // (covers species recorded before this column existed). Persist out-of-band.
  if (!s.ebird_code) {
    const code = await resolveEbirdCode(c.env, sci, s.com_name);
    if (code) {
      s.ebird_code = code;
      c.executionCtx.waitUntil(
        c.env.DB.prepare("UPDATE species SET ebird_code = ? WHERE sci_name = ?")
          .bind(code, sci)
          .run(),
      );
    }
  }

  // eBird/Macaulay photos are the preferred carousel source. Read the KV cache
  // populated out of band by the Playwright scraper (POST /admin/macaulay). When
  // a species hasn't been scraped yet we simply fall back to CUB / iNaturalist.
  let ebirdPhotos: PlumagePhoto[] = [];
  if (s.ebird_code) {
    const cached = await getCachedMacaulay(c.env, s.ebird_code);
    if (cached && cached.length) {
      ebirdPhotos = cached.map((p) => ({ url: p.url, label: p.label, credit: p.credit }));
    }
  }

  // CUB page link + fallback carousel photos (CUB plumage gallery, else
  // iNaturalist). KV-cached; best-effort so a source failure never breaks the
  // modal. We always fetch it for the Celebrate Urban Birds link chip.
  let cub: Awaited<ReturnType<typeof getCubInfo>> = { url: null, photos: [], source: null };
  try {
    cub = await getCubInfo(c.env, sci, s.com_name);
  } catch {
    /* ignore — degrade to no link / no gallery */
  }

  const useEbird = ebirdPhotos.length > 0;
  const plumage_photos = useEbird ? ebirdPhotos : cub.photos;
  const plumage_source: "ebird" | "cub" | "aab" | "obs" | null = useEbird ? "ebird" : cub.source;

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM detections WHERE sci_name = ? ORDER BY ts DESC LIMIT 20",
  )
    .bind(sci)
    .all<DetectionRow>();
  return c.json({
    species: enrichSpecies(c.env, s),
    recent: (results ?? []).map((d) => enrichDetection(c.env, d)),
    cub_url: cub.url,
    plumage_photos,
    plumage_source,
  });
});

// --- Phase 6 web-push subscription management ------------------------------

// Public VAPID key + whether push is enabled, for the client to subscribe.
api.get("/push/key", (c) => {
  return c.json({ enabled: Boolean(c.env.VAPID_PUBLIC_KEY), key: c.env.VAPID_PUBLIC_KEY || null });
});

// Store (or refresh) a PushSubscription.
api.post("/push/subscribe", async (c) => {
  const sub = (await c.req.json().catch(() => null)) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  } | null;
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return c.json({ error: "invalid subscription" }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
     VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth)
    .run();
  return c.json({ ok: true });
});

api.post("/push/unsubscribe", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: string } | null;
  if (!body?.endpoint) return c.json({ error: "endpoint required" }, 400);
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .bind(body.endpoint)
    .run();
  return c.json({ ok: true });
});

// Lightweight analytics (Phase 4 expands this into richer rollups).
api.get("/stats", async (c) => {
  const totals = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM detections) AS detections,
            (SELECT COUNT(*) FROM species) AS species`,
  ).first<{ detections: number; species: number }>();

  const since = Math.floor(Date.now() / 1000) - 86400;
  const { results: topToday } = await c.env.DB.prepare(
    `SELECT com_name, sci_name, COUNT(*) AS n
       FROM detections WHERE ts >= ?
       GROUP BY sci_name ORDER BY n DESC LIMIT 10`,
  )
    .bind(since)
    .all();

  c.header("Cache-Control", "public, max-age=60");
  return c.json({ totals, top_today: topToday ?? [] });
});

// --- Phase 4 analytics rollups ---------------------------------------------

function utcDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// Per-day totals + per-species daily series from the daily_stats rollup.
api.get("/stats/daily", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "30"), 1), 365);
  const from = utcDaysAgo(days);
  const { results } = await c.env.DB.prepare(
    `SELECT date, sci_name, com_name, count
       FROM daily_stats WHERE date >= ?
      ORDER BY date ASC, count DESC`,
  )
    .bind(from)
    .all<{ date: string; sci_name: string; com_name: string; count: number }>();
  const rows = results ?? [];

  const totalsByDate = new Map<string, number>();
  const speciesTotals = new Map<string, { com_name: string; count: number }>();
  for (const r of rows) {
    totalsByDate.set(r.date, (totalsByDate.get(r.date) ?? 0) + r.count);
    const s = speciesTotals.get(r.sci_name) ?? { com_name: r.com_name, count: 0 };
    s.count += r.count;
    speciesTotals.set(r.sci_name, s);
  }
  const daily = [...totalsByDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const top_species = [...speciesTotals.entries()]
    .map(([sci_name, v]) => ({ sci_name, com_name: v.com_name, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  c.header("Cache-Control", "public, max-age=60");
  return c.json({ from, days, daily, top_species, series: rows });
});

// Dawn-chorus histogram: detections per Eastern hour-of-day for one local date.
api.get("/stats/hourly", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const start = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  if (Number.isNaN(start)) return c.json({ error: "bad date" }, 400);
  const end = start + 86400;
  const { results } = await c.env.DB.prepare(
    `SELECT ${easternHourSql(start, end)} AS hour, COUNT(*) AS n
       FROM detections WHERE ts >= ? AND ts < ?
      GROUP BY hour`,
  )
    .bind(start, end)
    .all<{ hour: number; n: number }>();
  const buckets = new Array(24).fill(0) as number[];
  for (const r of results ?? []) if (r.hour != null) buckets[r.hour] = r.n;
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ date, hours: buckets });
});

// Diel activity: per-species call counts by Eastern hour-of-day over a window.
// Powers the species×hour heatmap and the stacked "calls by hour" chart.
api.get("/stats/diel", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "30"), 1), 3650);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "12"), 1), 30);
  const from = Number(c.req.query("from") ?? now - days * 86400);
  const to = Number(c.req.query("to") ?? now);
  const hourExpr = easternHourSql(from, to);

  const { results } = await c.env.DB.prepare(
    `SELECT sci_name, MAX(com_name) AS com_name, ${hourExpr} AS hour, COUNT(*) AS n
       FROM detections WHERE ts >= ? AND ts < ?
      GROUP BY sci_name, hour`,
  )
    .bind(from, to)
    .all<{ sci_name: string; com_name: string; hour: number; n: number }>();
  const rows = results ?? [];

  // Build per-species 24-hour vectors + grand total per hour.
  const byId = new Map<string, { com_name: string; total: number; hours: number[] }>();
  const total = new Array(24).fill(0) as number[];
  for (const r of rows) {
    if (r.hour == null || r.hour < 0 || r.hour > 23) continue;
    const e = byId.get(r.sci_name) ?? { com_name: r.com_name, total: 0, hours: new Array(24).fill(0) as number[] };
    e.hours[r.hour] = (e.hours[r.hour] ?? 0) + r.n;
    e.total += r.n;
    byId.set(r.sci_name, e);
    total[r.hour] = (total[r.hour] ?? 0) + r.n;
  }
  const all = [...byId.entries()]
    .map(([sci_name, v]) => ({ sci_name, com_name: v.com_name, total: v.total, hours: v.hours }))
    .sort((a, b) => b.total - a.total);
  const top = all.slice(0, limit);
  // Fold the remaining species into an "Other" row so totals still add up.
  if (all.length > limit) {
    const other = { sci_name: "", com_name: "Other species", total: 0, hours: new Array(24).fill(0) as number[] };
    for (const s of all.slice(limit)) {
      other.total += s.total;
      for (let h = 0; h < 24; h++) other.hours[h] = (other.hours[h] ?? 0) + (s.hours[h] ?? 0);
    }
    top.push(other);
  }

  c.header("Cache-Control", "public, max-age=120");
  return c.json({ from, to, species: top, total, species_count: all.length });
});

// Temporal co-occurrence: how often the top species are detected within the same
// time bucket (default 10 min) — "which birds are heard together".
api.get("/stats/cooccurrence", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "30"), 1), 3650);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "10"), 2), 16);
  const bucket = Math.min(Math.max(Number(c.req.query("bucket") ?? "600"), 60), 3600);
  const from = Number(c.req.query("from") ?? now - days * 86400);
  const to = Number(c.req.query("to") ?? now);

  // Top species + how many distinct buckets each appears in (the diagonal).
  const { results: sp } = await c.env.DB.prepare(
    `SELECT sci_name, MAX(com_name) AS com_name,
            COUNT(DISTINCT ts / CAST(?1 AS INTEGER)) AS buckets
       FROM detections WHERE ts >= ?2 AND ts < ?3
      GROUP BY sci_name ORDER BY COUNT(*) DESC LIMIT ?4`,
  )
    .bind(bucket, from, to, limit)
    .all<{ sci_name: string; com_name: string; buckets: number }>();
  const species = sp ?? [];

  let pairs: Array<{ s1: string; s2: string; n: number }> = [];
  if (species.length >= 2) {
    const names = species.map((s) => s.sci_name);
    const placeholders = names.map(() => "?").join(",");
    const { results: pr } = await c.env.DB.prepare(
      `WITH bkt AS (
         SELECT DISTINCT ts / CAST(? AS INTEGER) AS bk, sci_name
           FROM detections
          WHERE ts >= ? AND ts < ? AND sci_name IN (${placeholders})
       )
       SELECT x.sci_name AS s1, y.sci_name AS s2, COUNT(*) AS n
         FROM bkt x JOIN bkt y ON x.bk = y.bk AND x.sci_name < y.sci_name
        GROUP BY s1, s2`,
    )
      .bind(bucket, from, to, ...names)
      .all<{ s1: string; s2: string; n: number }>();
    pairs = pr ?? [];
  }

  c.header("Cache-Control", "public, max-age=120");
  return c.json({ from, to, bucket, species, pairs });
});

// Anomalies / notable detections: new-to-site, returned-after-absence (a strong
// proxy for seasonal migrants), and uncommon (few days / low count). Derived
// purely from our own history (species + daily_stats) — no external data.
api.get("/stats/anomalies", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "30"), 1), 365);
  const rareDays = Math.max(Number(c.req.query("rareDays") ?? c.env.RARE_SPECIES_DAYS ?? "30"), 1);
  const windowStart = now - days * 86400;
  const uncommonMaxDays = 2; // seen on <= this many distinct days => uncommon
  const uncommonMaxCount = 5;

  const { results: sp } = await c.env.DB.prepare(
    `SELECT sci_name, com_name, first_seen, last_seen, total_count FROM species`,
  ).all<{ sci_name: string; com_name: string; first_seen: number; last_seen: number; total_count: number }>();
  const species = sp ?? [];

  // Distinct active dates per species over the last year, to compute gaps + days-seen.
  const yearAgo = new Date(now * 1000 - 365 * 86400000).toISOString().slice(0, 10);
  const { results: ds } = await c.env.DB.prepare(
    `SELECT sci_name, date FROM daily_stats WHERE date >= ? ORDER BY sci_name, date ASC`,
  )
    .bind(yearAgo)
    .all<{ sci_name: string; date: string }>();
  const datesBy = new Map<string, string[]>();
  for (const r of ds ?? []) {
    const arr = datesBy.get(r.sci_name);
    if (arr) arr.push(r.date);
    else datesBy.set(r.sci_name, [r.date]);
  }

  const dayMs = 86400000;
  const items: Array<Record<string, unknown>> = [];
  for (const s of species) {
    const dates = datesBy.get(s.sci_name) ?? [];
    const daysSeen = dates.length;
    // Largest gap (in days) between consecutive active dates within the last year.
    let maxGap = 0;
    for (let i = 1; i < dates.length; i++) {
      const g = Math.round((Date.parse(dates[i]!) - Date.parse(dates[i - 1]!)) / dayMs);
      if (g > maxGap) maxGap = g;
    }
    const seenRecently = s.last_seen >= windowStart;
    let type: "new" | "returned" | "uncommon" | null = null;
    if (s.first_seen >= windowStart) type = "new";
    else if (seenRecently && maxGap > rareDays) type = "returned";
    else if (seenRecently && (daysSeen <= uncommonMaxDays || s.total_count <= uncommonMaxCount)) type = "uncommon";
    if (!type) continue;
    items.push({
      sci_name: s.sci_name,
      com_name: s.com_name,
      type,
      first_seen: s.first_seen,
      last_seen: s.last_seen,
      total_count: s.total_count,
      days_seen: daysSeen,
      gap_days: maxGap,
    });
  }
  items.sort((a, b) => (b.last_seen as number) - (a.last_seen as number));

  c.header("Cache-Control", "public, max-age=120");
  return c.json({ days, items });
});

// Species richness: distinct species per day.
api.get("/stats/richness", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "30"), 1), 365);
  const from = utcDaysAgo(days);
  const { results } = await c.env.DB.prepare(
    `SELECT date, COUNT(*) AS species
       FROM daily_stats WHERE date >= ?
      GROUP BY date ORDER BY date ASC`,
  )
    .bind(from)
    .all<{ date: string; species: number }>();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ from, days, richness: results ?? [] });
});

// Streamed CSV export of detections in a window (does not buffer in memory).
api.get("/export.csv", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const to = Number(c.req.query("to") ?? now);
  const from = Number(c.req.query("from") ?? to - 30 * 86400);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const csvCell = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await writer.write(
          enc.encode("id,ts,iso_time,sci_name,com_name,confidence,week,sensor_id\n"),
        );
        const PAGE = 1000;
        // Paginate by (ts, id) so we never drop rows that share a second.
        for (let offset = 0; ; offset += PAGE) {
          const { results } = await c.env.DB.prepare(
            `SELECT id, ts, sci_name, com_name, confidence, week, sensor_id
               FROM detections WHERE ts >= ? AND ts < ?
              ORDER BY ts ASC, id ASC LIMIT ? OFFSET ?`,
          )
            .bind(from, to, PAGE, offset)
            .all<DetectionRow>();
          const rows = results ?? [];
          if (rows.length === 0) break;
          let chunk = "";
          for (const d of rows) {
            const iso = new Date(d.ts * 1000).toISOString();
            chunk +=
              [d.id, d.ts, iso, d.sci_name, d.com_name, d.confidence, d.week, d.sensor_id]
                .map(csvCell)
                .join(",") + "\n";
          }
          await writer.write(enc.encode(chunk));
          if (rows.length < PAGE) break;
        }
      } finally {
        await writer.close();
      }
    })(),
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="birds-${from}-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
