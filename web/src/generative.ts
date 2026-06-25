// Deterministic, data-driven generative art (Phase 3.5c).
//
// Each tile is rendered purely from a detection's metadata so it is identical
// across reloads (no model cost, no network):
//   seed       = hash(detection id)        -> the whole composition
//   confidence -> stroke density           (more confident = busier)
//   hour-of-day-> background hue            (dawn warm, midday bright, night cool)
//   sci_name   -> palette                   (stable per species)
//   week       -> texture grain
import type { SpeciesAgg } from "./types";
import { hash32, mulberry32 } from "./util";

const SIZE = 320;
const cache = new Map<string, string>();

function hourHue(ts: number): number {
  const hour = new Date(ts * 1000).getHours();
  // Map 0..24h around the warm/cool wheel: night blues -> dawn ambers ->
  // midday greens -> dusk reds.
  return Math.round((hour / 24) * 300 + 20) % 360;
}

function weekOf(ts: number): number {
  const d = new Date(ts * 1000);
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / (7 * 86400000));
}

function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
}

/**
 * Render a stable generative tile for a detection. Returns a PNG data URL.
 * Cached by detection id so repeated renders are free and identical.
 */
export function generativeTile(agg: SpeciesAgg): string {
  const id = agg.last_id || agg.sci_name;
  const cached = cache.get(id);
  if (cached) return cached;

  const seed = hash32(id);
  const rnd = mulberry32(seed);
  const baseHue = hourHue(agg.last_ts);
  const paletteHue = hash32(agg.sci_name) % 360;
  const conf = Math.max(0.1, Math.min(1, agg.best_conf));
  const week = weekOf(agg.last_ts);

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Background: soft diagonal gradient blending the hour hue and species hue.
  const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  grad.addColorStop(0, hsl(baseHue, 42, 70));
  grad.addColorStop(1, hsl(paletteHue, 46, 52));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Radiating "song" petals — count driven by confidence.
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const petals = Math.round(16 + conf * 64);
  ctx.globalCompositeOperation = "multiply";
  for (let i = 0; i < petals; i++) {
    const ang = (i / petals) * Math.PI * 2 + rnd() * 0.4;
    const len = SIZE * (0.18 + rnd() * 0.34);
    const wide = 6 + rnd() * 22;
    const hue = paletteHue + (rnd() - 0.5) * 70;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.fillStyle = hsl(hue, 55, 50, 0.4);
    ctx.beginPath();
    ctx.ellipse(len * 0.5, 0, len * 0.5, wide, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Texture grain — density follows week-of-year.
  ctx.globalCompositeOperation = "source-over";
  const dots = 80 + (week % 26) * 16;
  for (let i = 0; i < dots; i++) {
    const x = rnd() * SIZE;
    const y = rnd() * SIZE;
    const r = rnd() * 2.2;
    ctx.fillStyle = hsl(baseHue, 30, rnd() > 0.5 ? 92 : 24, 0.18);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A calm central disc to anchor the composition.
  ctx.fillStyle = hsl(paletteHue, 40, 88, 0.85);
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.08, 0, Math.PI * 2);
  ctx.fill();

  const url = canvas.toDataURL("image/png");
  cache.set(id, url);
  return url;
}
