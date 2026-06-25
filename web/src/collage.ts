import type { SpeciesAgg } from "./types";
import { imgURL } from "./img";

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

export interface CollageCtx {
  // Resolved background for the active art style.
  imageFor(agg: SpeciesAgg): { url: string | null; cut: boolean };
}

interface PackTile {
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
function layout(aggs: SpeciesAgg[], W: number, H: number): PackTile[] {
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

// --- rendering (element reuse + CSS transitions for the "shift to make room"
//     effect when new birds join) ------------------------------------------
const els = new Map<string, HTMLButtonElement>();

let selectedTile: HTMLButtonElement | undefined;
let selectedSci: string | undefined;
let captionEl: HTMLElement | undefined;

/**
 * Register the element that shows the selected bird's name *under* the collage.
 * Called once at startup. Names are no longer painted over each photo; instead
 * the selected (hovered/tapped) bird's name appears in this caption.
 */
export function setCaptionEl(el: HTMLElement): void {
  captionEl = el;
}

/**
 * Pointer devices (mouse/trackpad) open the species modal on a single click and
 * preview names on hover. Touch devices have no hover, so they use a
 * tap-to-select, tap-again-to-open flow with the name shown under the collage.
 */
function canHover(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches;
}

function showCaption(name: string): void {
  if (!captionEl) return;
  captionEl.textContent = name;
  captionEl.classList.add("show");
}

function clearCaption(): void {
  captionEl?.classList.remove("show");
}

/** After a transient hover/focus ends, fall back to the persistent selection. */
function revertCaption(): void {
  const name = selectedTile?.dataset.com;
  if (name) showCaption(name);
  else clearCaption();
}

/** Make a tile the current selection: persistent outline + name under collage. */
function selectTile(el: HTMLButtonElement): void {
  if (selectedTile && selectedTile !== el) {
    selectedTile.classList.remove("selected", "highlight");
  }
  selectedTile = el;
  selectedSci = el.dataset.sci;
  el.classList.add("selected");
  if (el.dataset.com) showCaption(el.dataset.com);
}

/** Clear the selection and hide the under-collage name. */
function deselect(): void {
  selectedTile?.classList.remove("selected", "highlight");
  selectedTile = undefined;
  selectedSci = undefined;
  clearCaption();
}

/**
 * Drop all cached tile state. Call this when the main container is about to be
 * reused by another view (cards/list) so renderCollage rebuilds from scratch
 * next time instead of reusing now-detached DOM nodes.
 */
export function resetCollage(): void {
  els.clear();
  deselect();
}

/**
 * Select + pop the tile for a species (driven by ticker chip clicks). Selecting
 * also shows the bird's name under the collage. Only one tile is ever selected:
 * any previous selection is cleared first.
 */
export function highlightTile(sci: string): void {
  const el = els.get(sci);
  if (!el) return;
  selectTile(el); // outline + name under the collage
  el.classList.remove("highlight");
  void el.offsetWidth; // restart the pop animation when re-selecting
  el.classList.add("highlight");
}

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function renderCollage(
  container: HTMLElement,
  aggs: SpeciesAgg[],
  ctx: CollageCtx,
  onClick: (a: SpeciesAgg) => void,
): void {
  const W = container.clientWidth;
  const H = container.clientHeight;
  const placed = layout(aggs, W, H);
  const seen = new Set<string>();

  for (const p of placed) {
    seen.add(p.agg.sci_name);
    let el = els.get(p.agg.sci_name);
    if (!el) {
      el = document.createElement("button");
      el.className = "tile enter";
      const e = el;
      const agg = p.agg;
      e.addEventListener("click", () => {
        if (canHover()) {
          // Mouse/trackpad: a click both selects and opens the species modal.
          selectTile(e);
          onClick(agg);
        } else if (selectedTile === e) {
          // Touch: a second tap on the already-selected tile opens the modal.
          onClick(agg);
        } else {
          // Touch: the first tap only selects (name appears under the collage).
          selectTile(e);
        }
      });
      // Pointer devices preview the name under the collage on hover/focus.
      e.addEventListener("mouseenter", () => showCaption(agg.com_name));
      e.addEventListener("mouseleave", revertCaption);
      e.addEventListener("focus", () => showCaption(agg.com_name));
      e.addEventListener("blur", revertCaption);
      container.appendChild(el);
      els.set(p.agg.sci_name, el);
      requestAnimationFrame(() => e.classList.remove("enter"));
    }
    const { url, cut } = ctx.imageFor(p.agg);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.width = `${p.w}px`;
    el.style.height = `${p.h}px`;
    el.classList.toggle("cut", cut && !!url);
    if (url) {
      // Serve a right-sized, modern-format variant for the tile's pixel size.
      const src = imgURL(url, p.w) ?? url;
      el.style.backgroundImage = `url("${src}")`;
      el.classList.remove("noimg");
    } else {
      el.style.backgroundImage = "none";
      el.style.setProperty("--hue", String(hue(p.agg.sci_name)));
      el.classList.add("noimg");
    }
    // The name lives in the under-collage caption now, not over the photo;
    // keep it on the tile as data + aria so hover/select and SR users get it.
    el.dataset.sci = p.agg.sci_name;
    el.dataset.com = p.agg.com_name;
    el.setAttribute("aria-label", `${p.agg.com_name}, ${p.agg.count} calls`);
  }

  for (const [sci, el] of els) {
    if (!seen.has(sci)) {
      if (selectedSci === sci) deselect();
      el.classList.add("leave");
      els.delete(sci);
      setTimeout(() => el.remove(), 500);
    }
  }
}
