import { describe, expect, it } from "vitest";
import {
  addDays,
  computeRecords,
  currentRun,
  dateRange,
  easternDayBoundsUtc,
  easternDateOf,
  easternMinutesOfDay,
  hhmm,
  longestRun,
  pctDelta,
  shannonByDay,
  sparkSeries,
  speciesWeekDeltas,
  speciesWeekPair,
  trailingWeeks,
  type DailySeriesRow,
} from "./analytics";

const row = (date: string, sci: string, count: number): DailySeriesRow => ({
  date,
  sci_name: sci,
  com_name: sci,
  count,
});

describe("date helpers", () => {
  it("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
  it("dateRange is inclusive", () => {
    expect(dateRange("2026-06-28", "2026-07-01")).toEqual([
      "2026-06-28",
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
    ]);
  });
});

describe("streaks", () => {
  it("longestRun finds the longest consecutive stretch", () => {
    const dates = ["2026-06-01", "2026-06-02", "2026-06-04", "2026-06-05", "2026-06-06"];
    expect(longestRun(dates)).toEqual({ len: 3, start: "2026-06-04", end: "2026-06-06" });
  });
  it("longestRun handles empty and single", () => {
    expect(longestRun([]).len).toBe(0);
    expect(longestRun(["2026-06-01"]).len).toBe(1);
  });
  it("currentRun accepts a run ending today or yesterday", () => {
    const dates = ["2026-06-29", "2026-06-30", "2026-07-01"];
    expect(currentRun(dates, "2026-07-01")).toBe(3);
    expect(currentRun(dates, "2026-07-02")).toBe(3); // today has no calls yet
    expect(currentRun(dates, "2026-07-03")).toBe(0); // streak broken
  });
});

describe("computeRecords", () => {
  const daily = [
    { date: "2026-06-28", count: 40 },
    { date: "2026-06-29", count: 90 },
    { date: "2026-06-30", count: 60 },
  ];
  const rows = [
    row("2026-06-28", "a", 10),
    row("2026-06-28", "b", 30),
    row("2026-06-29", "a", 50),
    row("2026-06-29", "b", 20),
    row("2026-06-29", "c", 20),
    row("2026-06-30", "a", 60),
  ];
  it("finds busiest and most diverse days and streaks", () => {
    const r = computeRecords(daily, rows, "2026-06-30");
    expect(r.busiest).toEqual({ date: "2026-06-29", count: 90 });
    expect(r.mostDiverse).toEqual({ date: "2026-06-29", species: 3 });
    expect(r.longestStreak?.sci_name).toBe("a");
    expect(r.longestStreak?.streak.len).toBe(3);
    expect(r.currentStreak).toEqual({ sci_name: "a", com_name: "a", len: 3 });
  });
  it("returns nulls on empty input", () => {
    const r = computeRecords([], [], "2026-06-30");
    expect(r.busiest).toBeNull();
    expect(r.mostDiverse).toBeNull();
    expect(r.longestStreak).toBeNull();
    expect(r.currentStreak).toBeNull();
  });
});

describe("shannonByDay", () => {
  it("computes ln(2) for an even two-species split and 0 for a single species", () => {
    const out = shannonByDay([
      row("2026-06-29", "a", 50),
      row("2026-06-29", "b", 50),
      row("2026-06-30", "a", 7),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.h).toBeCloseTo(Math.LN2, 6);
    expect(out[1]!.h).toBe(0);
  });
});

describe("week over week", () => {
  const daily = [
    { date: "2026-06-19", count: 10 }, // day 13 back — inside last week
    { date: "2026-06-25", count: 20 }, // day 7 back — last week
    { date: "2026-06-26", count: 30 }, // day 6 back — this week
    { date: "2026-07-02", count: 5 }, // today
  ];
  it("splits trailing 7 days vs the 7 before", () => {
    expect(trailingWeeks(daily, "2026-07-02")).toEqual({ thisWeek: 35, lastWeek: 30 });
  });
  it("counts distinct species per week", () => {
    const rows = [
      row("2026-06-25", "a", 1),
      row("2026-06-26", "a", 1),
      row("2026-06-26", "b", 1),
      row("2026-07-02", "c", 1),
    ];
    expect(speciesWeekPair(rows, "2026-07-02")).toEqual({ thisWeek: 3, lastWeek: 1 });
    expect(speciesWeekDeltas(rows, "2026-07-02").get("a")).toEqual({ thisWeek: 1, lastWeek: 1 });
  });
  it("pctDelta guards a zero baseline", () => {
    expect(pctDelta(30, 20)).toBe(50);
    expect(pctDelta(10, 0)).toBeNull();
  });
});

describe("sparkSeries", () => {
  it("zero-fills missing days", () => {
    const rows = [row("2026-06-28", "a", 3), row("2026-06-30", "a", 7), row("2026-06-29", "b", 9)];
    expect(sparkSeries(rows, "a", "2026-06-27", "2026-06-30")).toEqual([0, 3, 0, 7]);
  });
});

describe("eastern day bounds", () => {
  it("uses EDT (UTC-4) in summer and EST (UTC-5) in winter", () => {
    expect(easternDayBoundsUtc("2026-07-02")).toEqual({
      from: Date.UTC(2026, 6, 2, 4) / 1000,
      to: Date.UTC(2026, 6, 3, 4) / 1000,
    });
    expect(easternDayBoundsUtc("2026-01-15")).toEqual({
      from: Date.UTC(2026, 0, 15, 5) / 1000,
      to: Date.UTC(2026, 0, 16, 5) / 1000,
    });
  });
  it("gives the spring-forward day 23 hours and the fall-back day 25", () => {
    const spring = easternDayBoundsUtc("2026-03-08"); // 2nd Sunday of March 2026
    expect((spring.to - spring.from) / 3600).toBe(23);
    const fall = easternDayBoundsUtc("2026-11-01"); // 1st Sunday of November 2026
    expect((fall.to - fall.from) / 3600).toBe(25);
  });
  it("maps instants to the Eastern calendar date", () => {
    // 03:00 UTC on Jul 3 is 11pm Jul 2 Eastern.
    expect(easternDateOf(Date.UTC(2026, 6, 3, 3) / 1000)).toBe("2026-07-02");
    expect(easternMinutesOfDay(Date.UTC(2026, 6, 2, 9, 43) / 1000)).toBe(5 * 60 + 43); // 5:43a EDT
  });
});

describe("hhmm", () => {
  it("formats morning/afternoon/midnight", () => {
    expect(hhmm(0)).toBe("12:00a");
    expect(hhmm(5 * 60 + 43)).toBe("5:43a");
    expect(hhmm(13 * 60 + 5)).toBe("1:05p");
  });
});
