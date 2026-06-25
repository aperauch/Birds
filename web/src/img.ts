// Build a Cloudflare Image Transformations URL for a same-origin /media image so
// the client downloads a right-sized, modern-format (AVIF/WebP) variant instead
// of the multi-MB original (e.g. a 6 MB Wikipedia JPEG -> ~8 KB AVIF thumbnail).
//
// Only our own R2-backed /media assets are transformed; data: URLs (generative
// art) and external CDNs (eBird/Macaulay) are returned unchanged. Widths are
// snapped to a small ladder so we generate few unique transformations (good for
// cache hit-rate and well within the free transformation tier).
const LADDER = [96, 160, 240, 320, 400, 512, 640, 768, 1024, 1280];

function snap(w: number): number {
  for (const b of LADDER) if (w <= b) return b;
  return LADDER[LADDER.length - 1]!;
}

export function imgURL(
  url: string | null | undefined,
  cssWidth: number,
  opts?: { quality?: number },
): string | null {
  if (!url) return url ?? null;
  let u: URL;
  try {
    u = new URL(url, location.origin);
  } catch {
    return url;
  }
  // Transform only our own media; leave data:/blob: and external CDNs alone.
  if (u.origin !== location.origin || !u.pathname.startsWith("/media/")) return url;

  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  const w = snap(Math.ceil(cssWidth * dpr));
  const params = `width=${w},quality=${opts?.quality ?? 80},format=auto,fit=cover`;
  return `${u.origin}/cdn-cgi/image/${params}${u.pathname}`;
}
