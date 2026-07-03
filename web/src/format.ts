// Shared text/label formatting helpers (pure — unit-tested in format.test.ts).

/** Escape a string for interpolation into HTML text or attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
export const escapeAttr = escapeHtml;

/**
 * Compact relative-time label from an age in seconds: "just now" / "23m ago" /
 * "3h ago" / "2d ago". `justNowS` is the "just now" cutoff and `dayAfterH` the
 * hour count after which the label switches to days (call sites historically
 * used slightly different thresholds; both are preserved via the wrappers).
 */
export function relFromSec(
  sec: number,
  opts: { justNowS?: number; dayAfterH?: number } = {},
): string {
  const justNowS = opts.justNowS ?? 45;
  const dayAfterH = opts.dayAfterH ?? 24;
  const s = Math.max(0, sec);
  if (s < justNowS) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < dayAfterH) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Relative time for a unix-seconds timestamp (cards/list style). */
export function relTime(ts: number, nowS = Math.floor(Date.now() / 1000)): string {
  return relFromSec(nowS - ts);
}

/** Relative age label for an age already expressed in seconds (ticker/sensor style). */
export function ageLabel(sec: number): string {
  return relFromSec(sec, { justNowS: 90, dayAfterH: 48 });
}

/** Day-granularity relative label: "today" / "1 day ago" / "N days ago". */
export function agoDays(ts: number, nowMs = Date.now()): string {
  const d = Math.max(0, Math.round((nowMs / 1000 - ts) / 86400));
  return d === 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
}

/** 12-hour clock label for an hour-of-day: 0 -> "12a", 13 -> "1p". */
export function hourLabel(h: number): string {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${h < 12 ? "a" : "p"}`;
}

/** Short month+day label for a unix-seconds timestamp (locale-formatted). */
export function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** m:ss clock label for a duration in seconds (e.g. 75 -> "1:15"). */
export function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
