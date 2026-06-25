// Phase 5 — color e-paper wall frame.
//
// `GET /frame` returns a fixed 800x480, 6-color-friendly HTML layout of the
// last 24h (bold flat blocks, no gradients) designed for an Inky Impression
// (Spectra 6). A Cron Trigger screenshots it with the Browser Rendering
// binding, dithers it to the 6 fixed panel colors (Floyd-Steinberg), and
// stores the PNG at R2 `frame/latest.png`. The Pi frame client pulls that.
import puppeteer from "@cloudflare/puppeteer";
import { PhotonImage } from "@cf-wasm/photon";
import type { Bindings } from "./types";
import { keys } from "./media";

export const FRAME_W = 800;
export const FRAME_H = 480;

// Spectra 6 panel palette (approximate sRGB). The on-device `inky` library maps
// to its exact palette; we dither to these so blocks read as bold flat color.
const PALETTE: Array<[number, number, number]> = [
  [0, 0, 0], // black
  [255, 255, 255], // white
  [200, 40, 40], // red
  [235, 200, 30], // yellow
  [45, 140, 70], // green
  [40, 80, 165], // blue
];

// Block fill colors (drawn in the HTML) chosen from the palette so dithering is
// near-lossless. White/black reserved for background + text.
const BLOCK_COLORS = ["#c82828", "#ebc81e", "#2d8c46", "#2850a5"];

interface FrameDatum {
  com_name: string;
  count: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return BLOCK_COLORS[h % BLOCK_COLORS.length]!;
}

/** Build the self-contained /frame HTML from the last-24h rollup. */
export async function renderFrameHtml(env: Bindings): Promise<string> {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const { results } = await env.DB.prepare(
    `SELECT com_name, COUNT(*) AS count
       FROM detections WHERE ts >= ?
      GROUP BY sci_name ORDER BY count DESC LIMIT 24`,
  )
    .bind(since)
    .all<FrameDatum>();
  const rows = results ?? [];
  const speciesCount = rows.length;
  const totalCalls = rows.reduce((s, r) => s + r.count, 0);
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Blocks sized by sqrt(count) for a calm hierarchy; flat color, bold text.
  const blocks = rows
    .map((r) => {
      const scale = 0.55 + 0.45 * Math.sqrt(r.count / maxCount);
      const fs = Math.round(13 + scale * 11);
      return `<div class="b" style="background:${colorFor(r.com_name)};font-size:${fs}px">
        <span>${escapeHtml(r.com_name)}</span><b>${r.count}</b></div>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:${FRAME_W}px; height:${FRAME_H}px; background:#fff; color:#000;
      font-family: Arial, Helvetica, sans-serif; -webkit-font-smoothing:none; }
    .wrap { width:${FRAME_W}px; height:${FRAME_H}px; padding:14px 16px; display:flex; flex-direction:column; }
    header { display:flex; align-items:baseline; border-bottom:4px solid #000; padding-bottom:8px; }
    header h1 { font-size:30px; letter-spacing:-0.5px; }
    header .date { margin-left:auto; font-size:18px; font-weight:bold; }
    .stats { display:flex; gap:24px; margin:8px 0 10px; font-size:18px; font-weight:bold; }
    .stats .n { color:#2850a5; }
    .grid { flex:1; display:flex; flex-wrap:wrap; align-content:flex-start; gap:7px; overflow:hidden; }
    .b { color:#fff; border:3px solid #000; border-radius:8px; padding:7px 11px;
      display:flex; align-items:center; gap:9px; font-weight:bold; line-height:1; }
    .b b { background:#fff; color:#000; border-radius:5px; padding:2px 6px; font-size:0.85em; }
    .empty { font-size:22px; font-weight:bold; margin-top:40px; }
  </style></head>
  <body><div class="wrap">
    <header><h1>Birds</h1><span class="date">${escapeHtml(dateLabel)}</span></header>
    <div class="stats"><span><span class="n">${speciesCount}</span> species</span>
      <span><span class="n">${totalCalls}</span> calls today</span></div>
    <div class="grid">${blocks || '<div class="empty">No birds heard in the last 24 hours.</div>'}</div>
  </div></body></html>`;
}

// --- Floyd-Steinberg dithering to the 6-color panel palette ----------------
function nearest(r: number, g: number, b: number): [number, number, number] {
  let best = PALETTE[0]!;
  let bestD = Infinity;
  for (const p of PALETTE) {
    const dr = r - p[0];
    const dg = g - p[1];
    const db = b - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function dither(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const buf = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    buf[j] = rgba[i * 4]!;
    buf[j + 1] = rgba[i * 4 + 1]!;
    buf[j + 2] = rgba[i * 4 + 2]!;
  }
  const add = (x: number, y: number, er: number, eg: number, eb: number, f: number) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const k = (y * w + x) * 3;
    buf[k]! += er * f;
    buf[k + 1]! += eg * f;
    buf[k + 2]! += eb * f;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 3;
      const r = buf[k]!;
      const g = buf[k + 1]!;
      const b = buf[k + 2]!;
      const [nr, ng, nb] = nearest(r, g, b);
      buf[k] = nr;
      buf[k + 1] = ng;
      buf[k + 2] = nb;
      const er = r - nr;
      const eg = g - ng;
      const eb = b - nb;
      add(x + 1, y, er, eg, eb, 7 / 16);
      add(x - 1, y + 1, er, eg, eb, 3 / 16);
      add(x, y + 1, er, eg, eb, 5 / 16);
      add(x + 1, y + 1, er, eg, eb, 1 / 16);
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    out[i * 4] = buf[j]!;
    out[i * 4 + 1] = buf[j + 1]!;
    out[i * 4 + 2] = buf[j + 2]!;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * Screenshot /frame via Browser Rendering, dither to the Spectra 6 palette,
 * and store the PNG at R2 `frame/latest.png`. Returns the byte length stored.
 */
export async function regenerateFrame(env: Bindings): Promise<number> {
  const browser = await puppeteer.launch(env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0]);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: FRAME_W, height: FRAME_H });
    await page.goto(`${env.PUBLIC_BASE_URL}/frame`, { waitUntil: "networkidle0" });
    const shot = (await page.screenshot({ type: "png" })) as unknown as Uint8Array;

    const img = PhotonImage.new_from_byteslice(new Uint8Array(shot));
    let png: Uint8Array;
    try {
      const w = img.get_width();
      const h = img.get_height();
      const dithered = dither(img.get_raw_pixels(), w, h);
      const out = new PhotonImage(dithered, w, h);
      try {
        png = out.get_bytes();
      } finally {
        out.free();
      }
    } finally {
      img.free();
    }

    await env.MEDIA.put(keys.frameLatest(), png, {
      httpMetadata: { contentType: "image/png", cacheControl: "no-store" },
    });
    return png.length;
  } finally {
    await browser.close();
  }
}
