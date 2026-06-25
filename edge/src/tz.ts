// US Eastern local-hour bucketing for SQLite (D1 has no IANA tz database).
//
// Detection `ts` is a correct UTC epoch (the Pi forwarder converts BirdNET-Pi's
// local Eastern time via `datetime.strptime(...).astimezone().timestamp()`). To
// show bird activity by *local* hour we reconstruct US Eastern time: EDT (UTC-4)
// during the daylight-saving interval, EST (UTC-5) otherwise.
//
// Rule: spring forward on the 2nd Sunday of March at 02:00 EST (07:00 UTC);
// fall back on the 1st Sunday of November at 02:00 EDT (06:00 UTC).

function nthSundayUtcSec(year: number, monthIndex0: number, n: number): number {
  const firstMs = Date.UTC(year, monthIndex0, 1);
  const dow = new Date(firstMs).getUTCDay(); // 0 = Sunday
  const firstSunday = 1 + ((7 - dow) % 7);
  const day = firstSunday + (n - 1) * 7;
  return Math.floor(Date.UTC(year, monthIndex0, day) / 1000);
}

/** EDT [start, end) UTC-second intervals covering every year spanned by the window. */
export function edtIntervals(fromTs: number, toTs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const y0 = new Date(fromTs * 1000).getUTCFullYear();
  const y1 = new Date(toTs * 1000).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    const start = nthSundayUtcSec(y, 2, 2) + 7 * 3600; // 2nd Sun Mar 07:00 UTC
    const end = nthSundayUtcSec(y, 10, 1) + 6 * 3600; // 1st Sun Nov 06:00 UTC
    out.push([start, end]);
  }
  return out;
}

/** SQLite string-modifier expression: '-4 hours' (EDT) or '-5 hours' (EST). */
export function easternOffsetSql(fromTs: number, toTs: number, tsCol = "ts"): string {
  const conds = edtIntervals(fromTs, toTs)
    .map(([a, b]) => `(${tsCol} >= ${a} AND ${tsCol} < ${b})`)
    .join(" OR ");
  return conds ? `(CASE WHEN ${conds} THEN '-4 hours' ELSE '-5 hours' END)` : `'-5 hours'`;
}

/** SQLite expression for the Eastern local hour-of-day (0..23) of `tsCol`. */
export function easternHourSql(fromTs: number, toTs: number, tsCol = "ts"): string {
  return `CAST(strftime('%H', ${tsCol}, 'unixepoch', ${easternOffsetSql(fromTs, toTs, tsCol)}) AS INTEGER)`;
}
