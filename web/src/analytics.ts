// Pure client-side analytics derived from /api/stats/daily `series` rows and
// friends. No DOM, no fetch — unit-tested in analytics.test.ts; trends.ts (and
// the day explorer) render the results.

export interface DailySeriesRow {
  date: string; // YYYY-MM-DD (UTC — matches the daily_stats rollup)
  sci_name: string;
  com_name: string;
  count: number;
}

// ---- ISO-date arithmetic (UTC calendar) -------------------------------------

export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Inclusive list of ISO dates from `from` to `to`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---- streaks -----------------------------------------------------------------

export interface Streak {
  len: number;
  start: string;
  end: string;
}

/** Longest run of consecutive dates in a sorted-unique ISO date list. */
export function longestRun(dates: string[]): Streak {
  let best: Streak = { len: 0, start: "", end: "" };
  let runStart = "";
  let runLen = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]!;
    if (runLen > 0 && addDays(dates[i - 1]!, 1) === d) {
      runLen += 1;
    } else {
      runStart = d;
      runLen = 1;
    }
    if (runLen > best.len) best = { len: runLen, start: runStart, end: d };
  }
  return best;
}

/** Length of the run ending at `today` (or yesterday — today may be mid-day). */
export function currentRun(dates: string[], today: string): number {
  const have = new Set(dates);
  let end = today;
  if (!have.has(end)) end = addDays(today, -1);
  if (!have.has(end)) return 0;
  let len = 0;
  for (let d = end; have.has(d); d = addDays(d, -1)) len += 1;
  return len;
}

// ---- records & streaks card ---------------------------------------------------

export interface RecordsSummary {
  busiest: { date: string; count: number } | null;
  mostDiverse: { date: string; species: number } | null;
  longestStreak: { sci_name: string; com_name: string; streak: Streak } | null;
  currentStreak: { sci_name: string; com_name: string; len: number } | null;
}

export function computeRecords(
  daily: { date: string; count: number }[],
  rows: DailySeriesRow[],
  today: string,
): RecordsSummary {
  const busiest = daily.reduce<{ date: string; count: number } | null>(
    (m, d) => (m && m.count >= d.count ? m : d),
    null,
  );

  const speciesPerDay = new Map<string, number>();
  const datesBySpecies = new Map<string, { com: string; dates: string[] }>();
  for (const r of rows) {
    speciesPerDay.set(r.date, (speciesPerDay.get(r.date) ?? 0) + 1);
    const e = datesBySpecies.get(r.sci_name) ?? { com: r.com_name, dates: [] };
    e.dates.push(r.date);
    e.com = r.com_name;
    datesBySpecies.set(r.sci_name, e);
  }
  let mostDiverse: RecordsSummary["mostDiverse"] = null;
  for (const [date, species] of speciesPerDay) {
    if (!mostDiverse || species > mostDiverse.species || (species === mostDiverse.species && date > mostDiverse.date)) {
      mostDiverse = { date, species };
    }
  }

  let longestStreak: RecordsSummary["longestStreak"] = null;
  let currentStreak: RecordsSummary["currentStreak"] = null;
  for (const [sci, e] of datesBySpecies) {
    const dates = [...new Set(e.dates)].sort();
    const streak = longestRun(dates);
    if (!longestStreak || streak.len > longestStreak.streak.len) {
      longestStreak = { sci_name: sci, com_name: e.com, streak };
    }
    const cur = currentRun(dates, today);
    if (cur > 0 && (!currentStreak || cur > currentStreak.len)) {
      currentStreak = { sci_name: sci, com_name: e.com, len: cur };
    }
  }
  return { busiest, mostDiverse, longestStreak, currentStreak };
}

// ---- diversity ----------------------------------------------------------------

/** Shannon diversity H' (natural log) per day. */
export function shannonByDay(rows: DailySeriesRow[]): { date: string; h: number }[] {
  const byDate = new Map<string, number[]>();
  for (const r of rows) {
    if (r.count <= 0) continue;
    const arr = byDate.get(r.date) ?? [];
    arr.push(r.count);
    byDate.set(r.date, arr);
  }
  return [...byDate.entries()]
    .map(([date, counts]) => {
      const total = counts.reduce((s, c) => s + c, 0);
      let h = 0;
      for (const c of counts) {
        const p = c / total;
        h -= p * Math.log(p);
      }
      return { date, h };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---- week-over-week -------------------------------------------------------------

export interface WeekPair {
  thisWeek: number;
  lastWeek: number;
}

/** Sum of `count` over the trailing 7 days (ending `today`) vs the 7 before. */
export function trailingWeeks(
  daily: { date: string; count: number }[],
  today: string,
): WeekPair {
  const weekAgo = addDays(today, -6); // trailing week = today-6 .. today
  const twoWeeksAgo = addDays(today, -13);
  let thisWeek = 0;
  let lastWeek = 0;
  for (const d of daily) {
    if (d.date >= weekAgo && d.date <= today) thisWeek += d.count;
    else if (d.date >= twoWeeksAgo && d.date < weekAgo) lastWeek += d.count;
  }
  return { thisWeek, lastWeek };
}

/** Distinct active species in the trailing week vs the week before. */
export function speciesWeekPair(rows: DailySeriesRow[], today: string): WeekPair {
  const weekAgo = addDays(today, -6);
  const twoWeeksAgo = addDays(today, -13);
  const cur = new Set<string>();
  const prev = new Set<string>();
  for (const r of rows) {
    if (r.date >= weekAgo && r.date <= today) cur.add(r.sci_name);
    else if (r.date >= twoWeeksAgo && r.date < weekAgo) prev.add(r.sci_name);
  }
  return { thisWeek: cur.size, lastWeek: prev.size };
}

/** Per-species trailing-week pair (for the sparkline delta arrows). */
export function speciesWeekDeltas(
  rows: DailySeriesRow[],
  today: string,
): Map<string, WeekPair> {
  const weekAgo = addDays(today, -6);
  const twoWeeksAgo = addDays(today, -13);
  const out = new Map<string, WeekPair>();
  for (const r of rows) {
    const e = out.get(r.sci_name) ?? { thisWeek: 0, lastWeek: 0 };
    if (r.date >= weekAgo && r.date <= today) e.thisWeek += r.count;
    else if (r.date >= twoWeeksAgo && r.date < weekAgo) e.lastWeek += r.count;
    out.set(r.sci_name, e);
  }
  return out;
}

/** Percent change; null when there is no baseline (prev 0). */
export function pctDelta(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

// ---- sparkline series ------------------------------------------------------------

/** Per-day counts for one species over an inclusive date span, zero-filled. */
export function sparkSeries(
  rows: DailySeriesRow[],
  sci: string,
  from: string,
  to: string,
): number[] {
  const byDate = new Map<string, number>();
  for (const r of rows) {
    if (r.sci_name === sci) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.count);
  }
  return dateRange(from, to).map((d) => byDate.get(d) ?? 0);
}

// ---- US Eastern day bounds (client mirror of edge/src/tz.ts) ----------------------

function nthSundayUtc(year: number, monthIndex0: number, n: number): string {
  const firstMs = Date.UTC(year, monthIndex0, 1);
  const dow = new Date(firstMs).getUTCDay();
  const day = 1 + ((7 - dow) % 7) + (n - 1) * 7;
  return new Date(Date.UTC(year, monthIndex0, day)).toISOString().slice(0, 10);
}

/**
 * Whether *local midnight* of an Eastern date is on daylight time. The switch
 * happens at 02:00 local, so midnight of the spring-forward date is still EST
 * and midnight of the fall-back date is still EDT.
 */
function isEdtAtMidnight(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const spring = nthSundayUtc(year, 2, 2); // 2nd Sunday of March
  const fall = nthSundayUtc(year, 10, 1); // 1st Sunday of November
  return date > spring && date <= fall;
}

/**
 * UTC-second bounds [from, to) of one US-Eastern calendar date. DST-aware:
 * the spring-forward day is 23h long, the fall-back day 25h.
 */
export function easternDayBoundsUtc(date: string): { from: number; to: number } {
  const startOffset = isEdtAtMidnight(date) ? 4 : 5;
  const next = addDays(date, 1);
  const endOffset = isEdtAtMidnight(next) ? 4 : 5;
  const from = Date.parse(`${date}T00:00:00Z`) / 1000 + startOffset * 3600;
  const to = Date.parse(`${next}T00:00:00Z`) / 1000 + endOffset * 3600;
  return { from, to };
}

/** Today's date on the US-Eastern calendar for a unix-seconds instant. */
export function easternDateOf(ts: number): string {
  const utcDate = new Date(ts * 1000).toISOString().slice(0, 10);
  // Try the UTC date and its neighbours; exactly one contains the instant.
  for (const d of [utcDate, addDays(utcDate, -1), addDays(utcDate, 1)]) {
    const { from, to } = easternDayBoundsUtc(d);
    if (ts >= from && ts < to) return d;
  }
  return utcDate; // unreachable
}

/** Minutes after Eastern midnight for a unix-seconds instant. */
export function easternMinutesOfDay(ts: number): number {
  const { from } = easternDayBoundsUtc(easternDateOf(ts));
  return Math.floor((ts - from) / 60);
}

/** "5:43a" style label for minutes-after-midnight. */
export function hhmm(minOfDay: number): string {
  const h24 = Math.floor(minOfDay / 60) % 24;
  const m = Math.floor(minOfDay % 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")}${h24 < 12 ? "a" : "p"}`;
}
