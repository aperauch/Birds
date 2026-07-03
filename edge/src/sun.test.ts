import { describe, expect, it } from "vitest";
import { sunTimes } from "./sun";

const dayLenH = (date: string, lat: number, lon: number): number => {
  const s = sunTimes(date, lat, lon);
  if (!s) throw new Error("expected a result");
  return (s.sunset - s.sunrise) / 3600;
};

describe("sunTimes", () => {
  it("returns sunrise before sunset for a mid-latitude site", () => {
    const s = sunTimes("2026-07-02", 33.9, -83.4); // roughly Georgia
    expect(s).not.toBeNull();
    expect(s!.sunrise).toBeLessThan(s!.sunset);
    expect(Number.isFinite(s!.sunrise)).toBe(true);
    expect(Number.isFinite(s!.sunset)).toBe(true);
  });

  it("gives ~12h day length at the equinox, regardless of latitude", () => {
    // 2026 March equinox is Mar 20. Equinox day length is ~12h everywhere,
    // plus ~12-14 minutes from atmospheric refraction + the sun's apparent
    // radius (sunrise/sunset are defined at the disc's edge, not its center)
    // — a physical invariant, not an implementation detail, so this is a
    // meaningful correctness check.
    for (const lat of [10, 33.9, 45, 60]) {
      expect(dayLenH("2026-03-20", lat, -83.4)).toBeGreaterThan(11.9);
      expect(dayLenH("2026-03-20", lat, -83.4)).toBeLessThan(12.5);
    }
  });

  it("gives longer summer days at higher northern latitudes (June solstice)", () => {
    const lower = dayLenH("2026-06-21", 25, -83.4);
    const higher = dayLenH("2026-06-21", 55, -83.4);
    expect(higher).toBeGreaterThan(lower);
  });

  it("gives shorter winter days at higher northern latitudes (December solstice)", () => {
    const lower = dayLenH("2026-12-21", 25, -83.4);
    const higher = dayLenH("2026-12-21", 55, -83.4);
    expect(higher).toBeLessThan(lower);
  });

  it("shifts later in UTC time as longitude moves west, for the same local date", () => {
    // Same latitude, two longitudes ~15deg apart (~1h of solar time) west.
    const east = sunTimes("2026-07-02", 35, -80);
    const west = sunTimes("2026-07-02", 35, -95);
    expect(east).not.toBeNull();
    expect(west).not.toBeNull();
    expect(west!.sunrise).toBeGreaterThan(east!.sunrise);
  });

  it("returns null for polar night/day at extreme latitudes", () => {
    expect(sunTimes("2026-12-21", 80, 0)).toBeNull(); // polar night
    expect(sunTimes("2026-06-21", 80, 0)).toBeNull(); // polar day
  });

  it("returns null for a malformed date", () => {
    expect(sunTimes("not-a-date", 40, -80)).toBeNull();
  });
});
