import { describe, expect, it } from "vitest";
import { layout } from "./packing";
import type { SpeciesAgg } from "./types";

function agg(sci: string, count: number): SpeciesAgg {
  return {
    sci_name: sci,
    com_name: sci,
    count,
    last_ts: 0,
    best_conf: 0.9,
    photo_url: null,
    flux_url: null,
    cut_url: null,
    art_url: null,
    last_id: "",
  };
}

const SAMPLE = [
  agg("a", 387),
  agg("b", 47),
  agg("c", 18),
  agg("d", 14),
  agg("e", 11),
  agg("f", 6),
  agg("g", 5),
  agg("h", 4),
  agg("i", 2),
  agg("j", 1),
];

const W = 1200;
const H = 800;

describe("layout", () => {
  it("returns nothing for empty input or a zero-sized container", () => {
    expect(layout([], W, H)).toEqual([]);
    expect(layout(SAMPLE, 0, H)).toEqual([]);
    expect(layout(SAMPLE, W, 0)).toEqual([]);
  });

  it("places every tile exactly once", () => {
    const placed = layout(SAMPLE, W, H);
    expect(placed.map((p) => p.agg.sci_name).sort()).toEqual(
      SAMPLE.map((a) => a.sci_name).sort(),
    );
  });

  it("is deterministic for the same input", () => {
    const a = layout(SAMPLE, W, H).map((p) => [p.agg.sci_name, p.x, p.y, p.w, p.h]);
    const b = layout(SAMPLE, W, H).map((p) => [p.agg.sci_name, p.x, p.y, p.w, p.h]);
    expect(a).toEqual(b);
  });

  it("never overlaps two tiles", () => {
    const placed = layout(SAMPLE, W, H);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const p = placed[i]!;
        const q = placed[j]!;
        const overlap =
          p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
        expect(overlap, `${p.agg.sci_name} overlaps ${q.agg.sci_name}`).toBe(false);
      }
    }
  });

  it("keeps the cluster inside the container for typical input", () => {
    const placed = layout(SAMPLE, W, H);
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(W);
      expect(p.y + p.h).toBeLessThanOrEqual(H);
    }
  });

  it("gives more-heard species larger tiles", () => {
    const placed = layout(SAMPLE, W, H);
    const by = new Map(placed.map((p) => [p.agg.sci_name, p.w * p.h]));
    expect(by.get("a")!).toBeGreaterThan(by.get("j")!);
    expect(by.get("b")!).toBeGreaterThan(by.get("i")!);
  });
});
