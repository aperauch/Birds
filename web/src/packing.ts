// Pure collage layout math: count-weighted tile sizing + center-out golden-angle
// spiral packing on a coarse occupancy grid. No DOM — unit-tested in
// packing.test.ts; collage.ts renders the result.
import type { SpeciesAgg } from "./types";

// --- tuning -----------------------------------------------------------------
const AREA_BUDGET = 0.5; // fraction of the viewport the cluster aims to fill
const SIZE_EXP = 0.65; // count -> area exponent (drives the visual hierarchy)
const MIN_W = 66;
const MAX_W_FRAC = 0.34; // a single tile never exceeds this fraction of min(W,H)
const ASPECT = 1.15; // default tile aspect ratio (w/h)
const AR_BIAS = 1.65; // horizontal spread (wider, landscape-friendly clusters)

// Packing operates on a coarse cell grid: each tile reserves its padded
// rectangle, and two tiles collide iff they share a reserved cell — so tiles
// keep a one-cell gap.
const CELL = 7; // px per occupancy cell (also the effective inter-tile gap)
const CELL_OFFSET = 8192; // shifts possibly-negative cell coords positive
const CELL_STRIDE = 1 << 16; // packs (gx,gy) into one number key

export interface PackTile {
  agg: SpeciesAgg;
  x: number;
  y: number;
  w: number;
  h: number;
  // Local occupancy cells (dx,dy offsets) relative to the tile origin cell.
  cells: Array<[number, number]>;
}

export interface PlacedTile {
  agg: SpeciesAgg;
  x: number;
  y: number;
  w: number;
  h: number;
  cut: boolean;
}

function computeSizes(aggs: SpeciesAgg[], W: number, H: number): PackTile[] {
  const budget = AREA_BUDGET * W * H;
  const scores = aggs.map((a) => Math.pow(Math.max(1, a.count), SIZE_EXP));
  const sum = scores.reduce((s, v) => s + v, 0) || 1;
  const maxW = Math.max(MIN_W * 1.6, MAX_W_FRAC * Math.min(W, H));
  return aggs.map((a, i) => {
    const area = (budget / sum) * (scores[i] ?? 1);
    let w = Math.sqrt(area * ASPECT);
    w = Math.min(maxW, Math.max(MIN_W, w));
    return { agg: a, w, h: w / ASPECT, x: 0, y: 0, cells: [] };
  });
}

/** Build the local cell footprint a tile reserves at its current size: the
 *  rectangle plus a one-cell halo so neighbours keep a gap. */
function footprint(t: PackTile): Array<[number, number]> {
  const cols = Math.max(1, Math.round(t.w / CELL));
  const rows = Math.max(1, Math.round(t.h / CELL));
  const cells: Array<[number, number]> = [];
  for (let cy = -1; cy <= rows; cy++) {
    for (let cx = -1; cx <= cols; cx++) cells.push([cx, cy]);
  }
  return cells;
}

function cellKey(gx: number, gy: number): number {
  return (gy + CELL_OFFSET) * CELL_STRIDE + (gx + CELL_OFFSET);
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function packOnce(tiles: PackTile[], W: number, H: number): PackTile[] {
  tiles.sort((p, q) => q.w * q.h - p.w * p.h);
  const placed: PackTile[] = [];
  const occupancy = new Set<number>();
  const cx = W / 2;
  const cy = H / 2;
  for (const t of tiles) {
    t.cells = footprint(t);
    const step = Math.max(6, Math.min(t.w, t.h) / 3);
    let spotX = cx - t.w / 2;
    let spotY = cy - t.h / 2;
    for (let i = 0; i < 5000; i++) {
      const r = step * Math.sqrt(i);
      const ang = i * GOLDEN;
      const x = cx + Math.cos(ang) * r * AR_BIAS - t.w / 2;
      const y = cy + Math.sin(ang) * r - t.h / 2;
      const ox = Math.round(x / CELL);
      const oy = Math.round(y / CELL);
      let ok = true;
      for (const [dx, dy] of t.cells) {
        if (occupancy.has(cellKey(ox + dx, oy + dy))) {
          ok = false;
          break;
        }
      }
      if (ok) {
        spotX = x;
        spotY = y;
        break;
      }
    }
    t.x = spotX;
    t.y = spotY;
    const ox = Math.round(spotX / CELL);
    const oy = Math.round(spotY / CELL);
    for (const [dx, dy] of t.cells) occupancy.add(cellKey(ox + dx, oy + dy));
    placed.push(t);
  }
  return placed;
}

/** Pack tiles, shrinking up to 10x until the cluster fits, then center it. */
export function layout(aggs: SpeciesAgg[], W: number, H: number): PackTile[] {
  if (aggs.length === 0 || W === 0 || H === 0) return [];
  let tiles = computeSizes(aggs, W, H);
  for (let attempt = 0; attempt < 10; attempt++) {
    const placed = packOnce(
      tiles.map((t) => ({ ...t })),
      W,
      H,
    );
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of placed) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    }
    const bw = maxX - minX;
    const bh = maxY - minY;
    if (bw <= W && bh <= H) {
      const ox = (W - bw) / 2 - minX;
      const oy = (H - bh) / 2 - minY;
      for (const p of placed) {
        p.x += ox;
        p.y += oy;
      }
      return placed;
    }
    tiles = tiles.map((t) => ({ ...t, w: t.w * 0.93, h: t.h * 0.93 }));
  }
  return packOnce(tiles, W, H);
}
