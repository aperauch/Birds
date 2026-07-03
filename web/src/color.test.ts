import { describe, expect, it } from "vitest";
import { colorFor, hueFor } from "./color";

describe("hueFor", () => {
  it("is deterministic and in range", () => {
    for (const name of ["Sayornis phoebe", "Turdus migratorius", "x", ""]) {
      const h = hueFor(name);
      expect(h).toBe(hueFor(name));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
  it("separates different species (for these known names)", () => {
    expect(hueFor("Sayornis phoebe")).not.toBe(hueFor("Turdus migratorius"));
  });
});

describe("colorFor", () => {
  it("emits a theme-token-driven hsl for a species", () => {
    expect(colorFor("Sayornis phoebe")).toBe(
      `hsl(${hueFor("Sayornis phoebe")} var(--chart-s, 60%) var(--chart-l, 45%))`,
    );
  });
  it("uses the Other-species token for the empty id", () => {
    expect(colorFor("")).toContain("--chart-other");
  });
});
