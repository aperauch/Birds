import { describe, expect, it } from "vitest";
import { ageLabel, agoDays, escapeHtml, fmtClock, fmtDate, hourLabel, relFromSec, relTime } from "./format";

describe("escapeHtml", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<img src="x" onerror='a&b'>`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;",
    );
  });
  it("leaves plain text untouched", () => {
    expect(escapeHtml("Carolina Wren")).toBe("Carolina Wren");
  });
});

describe("relFromSec", () => {
  it("clamps negative ages to just now", () => {
    expect(relFromSec(-30)).toBe("just now");
  });
  it("uses the default 45s just-now cutoff (cards/list style)", () => {
    expect(relFromSec(44)).toBe("just now");
    expect(relFromSec(45)).toBe("1m ago");
  });
  it("rounds minutes and hours", () => {
    expect(relFromSec(120)).toBe("2m ago");
    expect(relFromSec(3570)).toBe("1h ago"); // 59.5m rounds to 60m -> falls through to hours
    expect(relFromSec(2 * 3600)).toBe("2h ago");
  });
  it("switches to days after the dayAfterH threshold", () => {
    expect(relFromSec(25 * 3600)).toBe("1d ago");
    expect(relFromSec(25 * 3600, { dayAfterH: 48 })).toBe("25h ago");
  });
});

describe("relTime", () => {
  it("computes the age from a timestamp against an injected now", () => {
    const now = 1_783_000_000;
    expect(relTime(now - 10, now)).toBe("just now");
    expect(relTime(now - 600, now)).toBe("10m ago");
    expect(relTime(now - 3 * 86400, now)).toBe("3d ago");
  });
});

describe("ageLabel (ticker/sensor thresholds)", () => {
  it("keeps just now up to 90s", () => {
    expect(ageLabel(89)).toBe("just now");
    expect(ageLabel(91)).toBe("2m ago");
  });
  it("keeps hours until 48h", () => {
    expect(ageLabel(40 * 3600)).toBe("40h ago");
    expect(ageLabel(49 * 3600)).toBe("2d ago");
  });
});

describe("agoDays", () => {
  const nowMs = Date.UTC(2026, 6, 2, 12, 0, 0);
  it("labels today / 1 day ago / N days ago", () => {
    expect(agoDays(nowMs / 1000 - 3600, nowMs)).toBe("today");
    expect(agoDays(nowMs / 1000 - 86400, nowMs)).toBe("1 day ago");
    expect(agoDays(nowMs / 1000 - 5 * 86400, nowMs)).toBe("5 days ago");
  });
});

describe("hourLabel", () => {
  it("renders 12-hour clock labels", () => {
    expect(hourLabel(0)).toBe("12a");
    expect(hourLabel(6)).toBe("6a");
    expect(hourLabel(12)).toBe("12p");
    expect(hourLabel(18)).toBe("6p");
    expect(hourLabel(23)).toBe("11p");
  });
});

describe("fmtClock", () => {
  it("pads seconds and omits hours", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(65)).toBe("1:05");
    expect(fmtClock(3599)).toBe("59:59");
  });
  it("falls back to 0:00 for invalid input", () => {
    expect(fmtClock(NaN)).toBe("0:00");
    expect(fmtClock(-5)).toBe("0:00");
    expect(fmtClock(Infinity)).toBe("0:00");
  });
});

describe("fmtDate", () => {
  it("includes the day of month", () => {
    // Locale-dependent month name; just assert the day number is present.
    const ts = Date.UTC(2026, 6, 2, 12) / 1000;
    expect(fmtDate(ts)).toMatch(/2/);
  });
});
