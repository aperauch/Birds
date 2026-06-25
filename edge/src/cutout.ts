// Background cutout for the FLUX species art.
//
// Workers AI has no background-removal model, so we chroma/luma-key the known
// warm cream ground that FLUX renders behind every bird. We sample the four
// corners to learn the exact background color, then flood-fill inward from the
// image border, setting alpha=0 on every connected pixel within a color
// distance of that ground. Flood-filling from the border (rather than a global
// threshold) preserves cream-colored regions *inside* the silhouette (a pale
// belly, an eye-ring) because they are not connected to the exterior.
//
// Decoding/encoding runs through `@cf-wasm/photon` (WASM, workerd-compatible).
import { PhotonImage } from "@cf-wasm/photon";

export interface Cutout {
  /** PNG bytes with a transparent background (alpha channel present). */
  png: Uint8Array;
  /** The keyed RGBA pixel buffer (reused to build silhouette masks). */
  rgba: Uint8Array;
  width: number;
  height: number;
}

// Squared RGB color distance threshold for "is this the cream ground?".
// ~34 per channel; generous enough for JPEG/PNG noise on a flat ground without
// eating into the painted bird.
const KEY_THRESHOLD_SQ = 34 * 34 * 3;

interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Average a small NxN patch around (px,py) to get a robust ground sample. */
function samplePatch(rgba: Uint8Array, w: number, h: number, px: number, py: number): RGB {
  const half = 4;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.max(0, py - half); y < Math.min(h, py + half); y++) {
    for (let x = Math.max(0, px - half); x < Math.min(w, px + half); x++) {
      const i = (y * w + x) * 4;
      r += rgba[i]!;
      g += rgba[i + 1]!;
      b += rgba[i + 2]!;
      n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

function dist2(rgba: Uint8Array, i: number, c: RGB): number {
  const dr = rgba[i]! - c.r;
  const dg = rgba[i + 1]! - c.g;
  const db = rgba[i + 2]! - c.b;
  return dr * dr + dg * dg + db * db;
}

/**
 * Produce a transparent-background cutout from a FLUX PNG. Mutates a copy of
 * the decoded pixels; the source bytes are left untouched.
 */
export function cutoutCream(pngBytes: Uint8Array): Cutout {
  const img = PhotonImage.new_from_byteslice(pngBytes);
  try {
    const w = img.get_width();
    const h = img.get_height();
    const rgba = img.get_raw_pixels(); // Uint8Array, RGBA, length w*h*4

    // Learn the ground color from the four corners (average them).
    const corners = [
      samplePatch(rgba, w, h, 0, 0),
      samplePatch(rgba, w, h, w - 1, 0),
      samplePatch(rgba, w, h, 0, h - 1),
      samplePatch(rgba, w, h, w - 1, h - 1),
    ];
    const bg: RGB = {
      r: corners.reduce((s, c) => s + c.r, 0) / 4,
      g: corners.reduce((s, c) => s + c.g, 0) / 4,
      b: corners.reduce((s, c) => s + c.b, 0) / 4,
    };

    const n = w * h;
    const removed = new Uint8Array(n); // 1 = background (will be transparent)
    const stack = new Uint32Array(n);
    let sp = 0;

    const consider = (p: number): void => {
      if (removed[p]) return;
      if (dist2(rgba, p * 4, bg) <= KEY_THRESHOLD_SQ) {
        removed[p] = 1;
        stack[sp++] = p;
      }
    };

    // Seed from every border pixel.
    for (let x = 0; x < w; x++) {
      consider(x); // top row
      consider((h - 1) * w + x); // bottom row
    }
    for (let y = 0; y < h; y++) {
      consider(y * w); // left col
      consider(y * w + (w - 1)); // right col
    }

    // 4-connected flood fill inward.
    while (sp > 0) {
      const p = stack[--sp]!;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) consider(p - 1);
      if (x < w - 1) consider(p + 1);
      if (y > 0) consider(p - w);
      if (y < h - 1) consider(p + w);
    }

    // Apply transparency.
    for (let p = 0; p < n; p++) {
      if (removed[p]) rgba[p * 4 + 3] = 0;
    }

    const out = new PhotonImage(rgba, w, h);
    try {
      const png = out.get_bytes();
      return { png, rgba, width: w, height: h };
    } finally {
      out.free();
    }
  } finally {
    img.free();
  }
}
