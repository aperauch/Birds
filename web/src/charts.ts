// Shared hand-rolled SVG chart primitives (no chart lib — keeps the bundle
// tiny). Used by the Trends page and the species-detail mini-charts in the
// modal, so a species' history looks the same wherever it appears.
const NS = "http://www.w3.org/2000/svg";

export function svg(w: number, h: number): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("width", "100%");
  s.classList.add("chart");
  return s;
}

// Render an SVG chart at the host's REAL pixel width so 1 user unit = 1px and
// the default (uniform) aspect ratio keeps text from stretching. Re-renders on
// resize; height stays fixed (the viewBox is `width × H`, so height = H px).
export function chartHost(build: (w: number) => SVGSVGElement): HTMLElement {
  const host = document.createElement("div");
  host.className = "chart-host";
  let last = 0;
  const paint = (): void => {
    const w = Math.round(host.clientWidth);
    if (w < 80 || w === last) return;
    last = w;
    host.replaceChildren(build(w));
  };
  new ResizeObserver(paint).observe(host);
  requestAnimationFrame(paint);
  return host;
}

export function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function title(parent: SVGElement | HTMLElement, text: string): void {
  const t = document.createElementNS(NS, "title");
  t.textContent = text;
  parent.appendChild(t);
}

export const CHART_W = 640;
export const CHART_H = 200;
export const CHART_PAD = { l: 34, r: 12, t: 12, b: 22 };

export function lineChart(
  points: { label: string; value: number }[],
  color: string,
  w = CHART_W,
  h = CHART_H,
): SVGSVGElement {
  const H = h;
  const PAD = CHART_PAD;
  const s = svg(w, H);
  const max = Math.max(1, ...points.map((p) => p.value));
  const iw = w - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (points.length <= 1 ? 0 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  s.append(el("line", { x1: PAD.l, y1: PAD.t + ih, x2: PAD.l + iw, y2: PAD.t + ih, class: "axis" }));
  s.append(el("line", { x1: PAD.l, y1: PAD.t, x2: PAD.l, y2: PAD.t + ih, class: "axis" }));
  const ylabel = el("text", { x: 2, y: PAD.t + 8, class: "tick" });
  ylabel.textContent = Number.isInteger(max) ? String(max) : max.toFixed(2);
  s.append(ylabel);
  if (points.length > 0) {
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const area = `${d} L${x(points.length - 1).toFixed(1)},${PAD.t + ih} L${x(0).toFixed(1)},${PAD.t + ih} Z`;
    // Colours may be var() tokens — presentation attributes don't resolve
    // custom properties, so paint via `style`.
    s.append(el("path", { d: area, style: `fill:${color};stroke:none`, "fill-opacity": "0.14" }));
    s.append(el("path", { d, style: `fill:none;stroke:${color}`, "stroke-width": 2 }));
    const first = el("text", { x: PAD.l, y: H - 6, class: "tick" });
    first.textContent = points[0]!.label.slice(5);
    const last = el("text", { x: PAD.l + iw, y: H - 6, class: "tick", "text-anchor": "end" });
    last.textContent = points[points.length - 1]!.label.slice(5);
    s.append(first, last);
  }
  return s;
}

export function barChart(
  values: number[],
  labels: string[],
  color: string,
  every = 6,
  w = CHART_W,
  h = CHART_H,
): SVGSVGElement {
  const H = h;
  const PAD = CHART_PAD;
  const s = svg(w, H);
  const max = Math.max(1, ...values);
  const iw = w - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / values.length;
  s.append(el("line", { x1: PAD.l, y1: PAD.t + ih, x2: PAD.l + iw, y2: PAD.t + ih, class: "axis" }));
  values.forEach((v, i) => {
    const bh = (v / max) * ih;
    const r = el("rect", {
      x: PAD.l + i * bw + 1,
      y: PAD.t + ih - bh,
      width: Math.max(1, bw - 2),
      height: bh,
      style: `fill:${color}`,
      rx: 1.5,
    });
    title(r, `${labels[i]}: ${v}`);
    s.append(r);
  });
  labels.forEach((lab, i) => {
    if (i % every === 0) {
      const t = el("text", { x: PAD.l + i * bw + bw / 2, y: H - 6, class: "tick", "text-anchor": "middle" });
      t.textContent = lab;
      s.append(t);
    }
  });
  return s;
}

/** Minimal sparkline: a single stroked polyline, no axes/labels. */
export function spark(values: number[], color: string, w = 120, h = 26): SVGSVGElement {
  const s = svg(w, h);
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? w / 2 : 2 + (i / (n - 1)) * (w - 4));
  const y = (v: number) => h - 3 - (v / max) * (h - 6);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  s.append(
    el("path", {
      d,
      style: `fill:none;stroke:${color}`,
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  return s;
}
