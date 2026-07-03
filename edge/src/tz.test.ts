import { describe, expect, it } from "vitest";
import { easternHourSql, easternOffsetSql, edtIntervals } from "./tz";

const ts = (y: number, m0: number, d: number, h = 0) => Date.UTC(y, m0, d, h) / 1000;

describe("edtIntervals", () => {
  it("computes the 2026 EDT window (2nd Sun Mar 07:00 UTC .. 1st Sun Nov 06:00 UTC)", () => {
    // 2026: Mar 1 is a Sunday -> 2nd Sunday Mar 8; Nov 1 is a Sunday.
    const [interval] = edtIntervals(ts(2026, 0, 1), ts(2026, 11, 31));
    expect(interval).toEqual([ts(2026, 2, 8, 7), ts(2026, 10, 1, 6)]);
  });

  it("computes the 2025 EDT window", () => {
    // 2025: Mar 1 is a Saturday -> 2nd Sunday Mar 9; first Sunday of Nov is Nov 2.
    const [interval] = edtIntervals(ts(2025, 0, 1), ts(2025, 11, 31));
    expect(interval).toEqual([ts(2025, 2, 9, 7), ts(2025, 10, 2, 6)]);
  });

  it("returns one interval per year spanned by the window", () => {
    const intervals = edtIntervals(ts(2024, 11, 30), ts(2026, 0, 2));
    expect(intervals).toHaveLength(3); // 2024, 2025, 2026
    for (const [start, end] of intervals) expect(start).toBeLessThan(end);
  });
});

describe("easternOffsetSql", () => {
  it("branches between EDT (-4) and EST (-5) on the interval bounds", () => {
    const from = ts(2026, 0, 1);
    const to = ts(2026, 11, 31);
    const sql = easternOffsetSql(from, to);
    expect(sql).toContain("'-4 hours'");
    expect(sql).toContain("'-5 hours'");
    expect(sql).toContain(`ts >= ${ts(2026, 2, 8, 7)}`);
    expect(sql).toContain(`ts < ${ts(2026, 10, 1, 6)}`);
  });

  it("respects a custom timestamp column name", () => {
    const sql = easternOffsetSql(ts(2026, 5, 1), ts(2026, 6, 1), "d.ts");
    expect(sql).toContain("d.ts >=");
    expect(sql).not.toMatch(/\(ts >=/); // no bare `ts` column left behind
  });
});

describe("easternHourSql", () => {
  it("wraps the offset in an hour-of-day strftime cast", () => {
    const sql = easternHourSql(ts(2026, 5, 1), ts(2026, 6, 1));
    expect(sql).toMatch(/^CAST\(strftime\('%H', ts, 'unixepoch', /);
    expect(sql).toMatch(/AS INTEGER\)$/);
  });
});
