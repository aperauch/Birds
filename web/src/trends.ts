// Analytics "Trends" view. Hand-rolled SVG + CSS-grid charts (no chart lib) to
// keep the bundle tiny. Rendered into #trends when the route is #/trends.
//
// Cards: summary tiles · detections/day · species richness/day · life-list
// growth · diel activity heatmap (species × Eastern hour) · calls-by-hour
// (stacked by species) · co-occurrence matrix · new & notable (anomalies) ·
// calendar heatmap · day-of-week · top species. Hour-of-day is the sensor's
// Eastern local time (DST-aware, computed server-side).
import {
  listSpecies,
  statsAnomalies,
  statsCooccurrence,
  statsDaily,
  statsDiel,
  statsRichness,
  type Anomaly,
  type CoocPair,
  type CoocSpecies,
  type DielSpecies,
} from "./api";
import type { Species } from "./types";

const NS = "http://www.w3.org/2000/svg";

const RANGES: { label: string; days: number }[] = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "1Y", days: 365 },
  { label: "All", days: 3650 },
];
let rangeDays = 30;

// --- helpers ----------------------------------------------------------------
function svg(w: number, h: number): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("width", "100%");
  s.classList.add("chart");
  return s;
}

// Render an SVG chart at the host's REAL pixel width so 1 user unit = 1px and
// the default (uniform) aspect ratio keeps text from stretching. Re-renders on
// resize; height stays fixed (the viewBox is `width × H`, so height = H px).
function chartHost(build: (w: number) => SVGSVGElement): HTMLElement {
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

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function title(parent: SVGElement | HTMLElement, text: string): void {
  const t = document.createElementNS(NS, "title");
  t.textContent = text;
  parent.appendChild(t);
}

function card(titleText: string, body: SVGElement | HTMLElement, wide = false): HTMLElement {
  const c = document.createElement("section");
  c.className = wide ? "trend-card wide" : "trend-card";
  const h = document.createElement("h3");
  h.textContent = titleText;
  c.append(h, body);
  return c;
}

function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
function colorFor(sci: string): string {
  return sci ? `hsl(${hueFor(sci)} 60% 45%)` : "#9b8e76"; // "" => Other species
}
function hourLabel(h: number): string {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${h < 12 ? "a" : "p"}`;
}
function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function ago(ts: number): string {
  const d = Math.max(0, Math.round((Date.now() / 1000 - ts) / 86400));
  return d === 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
}
function sciSpan(sci: string, com: string): string {
  return `<span class="lnk" data-sci="${sci.replace(/"/g, "&quot;")}" role="link" tabindex="0">${escapeHtml(com)}</span>`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

const W = 640;
const H = 200;
const PAD = { l: 34, r: 12, t: 12, b: 22 };

function lineChart(points: { label: string; value: number }[], color: string, w = W): SVGSVGElement {
  const s = svg(w, H);
  const max = Math.max(1, ...points.map((p) => p.value));
  const iw = w - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (points.length <= 1 ? 0 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  s.append(el("line", { x1: PAD.l, y1: PAD.t + ih, x2: PAD.l + iw, y2: PAD.t + ih, class: "axis" }));
  s.append(el("line", { x1: PAD.l, y1: PAD.t, x2: PAD.l, y2: PAD.t + ih, class: "axis" }));
  const ylabel = el("text", { x: 2, y: PAD.t + 8, class: "tick" });
  ylabel.textContent = String(max);
  s.append(ylabel);
  if (points.length > 0) {
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const area = `${d} L${x(points.length - 1).toFixed(1)},${PAD.t + ih} L${x(0).toFixed(1)},${PAD.t + ih} Z`;
    s.append(el("path", { d: area, fill: color, "fill-opacity": "0.14", stroke: "none" }));
    s.append(el("path", { d, fill: "none", stroke: color, "stroke-width": 2 }));
    const first = el("text", { x: PAD.l, y: H - 6, class: "tick" });
    first.textContent = points[0]!.label.slice(5);
    const last = el("text", { x: PAD.l + iw, y: H - 6, class: "tick", "text-anchor": "end" });
    last.textContent = points[points.length - 1]!.label.slice(5);
    s.append(first, last);
  }
  return s;
}

function barChart(values: number[], labels: string[], color: string, every = 6, w = W): SVGSVGElement {
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
      fill: color,
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

function topList(items: { sci_name: string; com_name: string; count: number }[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "top-list";
  const max = Math.max(1, ...items.map((i) => i.count));
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "top-row";
    row.innerHTML = `${sciSpan(it.sci_name, it.com_name)}
      <span class="top-bar"><i style="width:${(it.count / max) * 100}%"></i></span>
      <span class="top-n">${it.count}</span>`;
    wrap.append(row);
  }
  return wrap;
}

// --- summary stat tiles -----------------------------------------------------
function statTiles(t: { k: string; v: string; sub?: string }[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "trend-tiles";
  wrap.innerHTML = t
    .map(
      (x) =>
        `<div class="tile-stat"><span class="v">${escapeHtml(x.v)}</span><span class="k">${escapeHtml(x.k)}</span>${x.sub ? `<span class="s">${escapeHtml(x.sub)}</span>` : ""}</div>`,
    )
    .join("");
  return wrap;
}

// --- diel heatmap (species × Eastern hour) ----------------------------------
function heatmap(species: DielSpecies[], normalize: boolean): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "heatmap";
  const globalMax = Math.max(1, ...species.flatMap((s) => s.hours));
  // hour header
  const head = document.createElement("div");
  head.className = "hm-row hm-hours";
  head.innerHTML = `<span class="hm-label"></span>${Array.from({ length: 24 })
    .map((_, h) => `<span class="hm-hr">${h % 6 === 0 ? hourLabel(h) : ""}</span>`)
    .join("")}`;
  grid.append(head);
  for (const s of species) {
    const rowMax = normalize ? Math.max(1, ...s.hours) : globalMax;
    const row = document.createElement("div");
    row.className = "hm-row";
    const cells = s.hours
      .map((n, h) => {
        const bg = n === 0 ? "" : ` style="background:rgba(138,90,43,${(0.12 + 0.88 * (n / rowMax)).toFixed(3)})"`;
        return `<span class="hm-cell"${bg} title="${escapeHtml(s.com_name)} · ${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${n} call${n === 1 ? "" : "s"}"></span>`;
      })
      .join("");
    row.innerHTML = `${sciSpan(s.sci_name, s.com_name).replace("lnk", "lnk hm-label")}${cells}`;
    grid.append(row);
  }
  return grid;
}

function dielCard(species: DielSpecies[]): HTMLElement {
  const c = document.createElement("section");
  c.className = "trend-card wide";
  const head = document.createElement("div");
  head.className = "trend-card-head";
  head.innerHTML = `<h3>Daily activity by species — Eastern time</h3>`;
  const toggle = document.createElement("button");
  toggle.className = "mini-toggle";
  toggle.type = "button";
  let normalize = false;
  toggle.textContent = "Normalize rows";
  head.append(toggle);
  const holder = document.createElement("div");
  const draw = () => {
    holder.innerHTML = "";
    holder.append(heatmap(species, normalize));
  };
  toggle.addEventListener("click", () => {
    normalize = !normalize;
    toggle.classList.toggle("on", normalize);
    draw();
  });
  draw();
  c.append(head, holder);
  return c;
}

// --- calls by hour, stacked by species --------------------------------------
function stackedSvg(species: DielSpecies[], w: number): SVGSVGElement {
  const hourTotals = Array.from({ length: 24 }, (_, h) =>
    species.reduce((sum, s) => sum + (s.hours[h] ?? 0), 0),
  );
  const max = Math.max(1, ...hourTotals);
  const s = svg(w, H);
  const iw = w - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / 24;
  s.append(el("line", { x1: PAD.l, y1: PAD.t + ih, x2: PAD.l + iw, y2: PAD.t + ih, class: "axis" }));
  const yl = el("text", { x: 2, y: PAD.t + 8, class: "tick" });
  yl.textContent = String(max);
  s.append(yl);
  for (let h = 0; h < 24; h++) {
    let yCursor = PAD.t + ih;
    for (const sp of species) {
      const v = sp.hours[h] ?? 0;
      if (v <= 0) continue;
      const segH = (v / max) * ih;
      yCursor -= segH;
      const r = el("rect", {
        x: PAD.l + h * bw + 0.5,
        y: yCursor,
        width: Math.max(1, bw - 1),
        height: segH,
        fill: colorFor(sp.sci_name),
      });
      title(r, `${sp.com_name} · ${hourLabel(h)}: ${v}`);
      s.append(r);
    }
    if (h % 6 === 0) {
      const t = el("text", { x: PAD.l + h * bw + bw / 2, y: H - 6, class: "tick", "text-anchor": "middle" });
      t.textContent = hourLabel(h);
      s.append(t);
    }
  }
  return s;
}

function stackedHours(species: DielSpecies[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.append(
    chartHost((w) => stackedSvg(species, w)),
    legend(species.map((sp) => ({ sci: sp.sci_name, com: sp.com_name }))),
  );
  return wrap;
}

function legend(items: { sci: string; com: string }[]): HTMLElement {
  const l = document.createElement("div");
  l.className = "legend";
  l.innerHTML = items
    .map(
      (i) =>
        `<span class="legend-item"><i class="swatch" style="background:${colorFor(i.sci)}"></i>${sciSpan(i.sci, i.com)}</span>`,
    )
    .join("");
  return l;
}

// --- co-occurrence matrix ---------------------------------------------------
function coocMatrix(species: CoocSpecies[], pairs: CoocPair[]): HTMLElement {
  const n = species.length;
  const idx = new Map(species.map((s, i) => [s.sci_name, i] as const));
  const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  let max = 1;
  for (const p of pairs) {
    const i = idx.get(p.s1);
    const j = idx.get(p.s2);
    if (i == null || j == null) continue;
    m[i]![j] = p.n;
    m[j]![i] = p.n;
    if (p.n > max) max = p.n;
  }
  const grid = document.createElement("div");
  grid.className = "cooc";
  grid.style.setProperty("--n", String(n));
  // header row: corner + abbreviated species
  let html = `<span class="cooc-corner"></span>`;
  for (const s of species) {
    const abbr = s.com_name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
    html += `<span class="cooc-colh" title="${escapeHtml(s.com_name)}">${abbr}</span>`;
  }
  for (let i = 0; i < n; i++) {
    html += `${sciSpan(species[i]!.sci_name, species[i]!.com_name).replace("lnk", "lnk cooc-rowh")}`;
    for (let j = 0; j < n; j++) {
      if (i === j) {
        html += `<span class="cooc-cell diag" title="${escapeHtml(species[i]!.com_name)}: ${species[i]!.buckets} active windows"></span>`;
      } else {
        const v = m[i]![j]!;
        const bg = v === 0 ? "" : ` style="background:rgba(74,138,61,${(0.12 + 0.88 * (v / max)).toFixed(3)})"`;
        html += `<span class="cooc-cell"${bg} title="${escapeHtml(species[i]!.com_name)} + ${escapeHtml(species[j]!.com_name)}: ${v} shared windows"></span>`;
      }
    }
  }
  grid.innerHTML = html;
  return grid;
}

// --- anomalies table --------------------------------------------------------
function anomaliesTable(items: Anomaly[]): HTMLElement {
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "loading";
    p.textContent = "Nothing unusual in this range.";
    return p;
  }
  const labels: Record<Anomaly["type"], string> = {
    new: "New",
    returned: "Returned",
    uncommon: "Uncommon",
  };
  const wrap = document.createElement("div");
  wrap.className = "anoms";
  wrap.innerHTML = items
    .slice(0, 40)
    .map((a) => {
      const detail =
        a.type === "new"
          ? `first seen ${ago(a.first_seen)}`
          : a.type === "returned"
            ? `back after ~${a.gap_days}d · last ${ago(a.last_seen)}`
            : `${a.total_count} call${a.total_count === 1 ? "" : "s"} · ${a.days_seen} day${a.days_seen === 1 ? "" : "s"}`;
      return `<div class="anom-row">
        <span class="badge ${a.type}">${labels[a.type]}</span>
        ${sciSpan(a.sci_name, a.com_name)}
        <span class="anom-detail">${escapeHtml(detail)}</span>
      </div>`;
    })
    .join("");
  return wrap;
}

// --- life-list growth (cumulative distinct species) -------------------------
function lifeList(species: Species[]): HTMLElement {
  const firsts = species
    .map((s) => s.first_seen)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  const points = firsts.map((ts, i) => ({ label: new Date(ts * 1000).toISOString().slice(0, 10), value: i + 1 }));
  return chartHost((w) => lineChart(points, "#2850a5", w));
}

// --- calendar heatmap (detections per day) ----------------------------------
function calendar(daily: { date: string; count: number }[]): HTMLElement {
  const byDate = new Map(daily.map((d) => [d.date, d.count]));
  const max = Math.max(1, ...daily.map((d) => d.count));
  const today = new Date();
  const days = Math.min(rangeDays, 182);
  // Start on the Sunday on/before the first day so columns are aligned weeks.
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  start.setDate(start.getDate() - start.getDay()); // back to Sunday
  const grid = document.createElement("div");
  grid.className = "cal";
  const cur = new Date(start);
  while (cur <= today) {
    const iso = cur.toISOString().slice(0, 10);
    const n = byDate.get(iso) ?? 0;
    const a = n === 0 ? 0 : 0.12 + 0.88 * (n / max);
    const cell = document.createElement("span");
    cell.className = "cal-day";
    cell.style.background = n === 0 ? "var(--line)" : `rgba(138,90,43,${a.toFixed(3)})`;
    cell.title = `${iso}: ${n} call${n === 1 ? "" : "s"}`;
    grid.append(cell);
    cur.setDate(cur.getDate() + 1);
  }
  return grid;
}

// --- day of week ------------------------------------------------------------
function dayOfWeek(daily: { date: string; count: number }[]): HTMLElement {
  const dow = new Array(7).fill(0) as number[];
  for (const d of daily) {
    const wd = new Date(`${d.date}T12:00:00Z`).getUTCDay();
    dow[wd] = (dow[wd] ?? 0) + d.count;
  }
  // Reorder Mon..Sun
  const order = [1, 2, 3, 4, 5, 6, 0];
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const vals = order.map((i) => dow[i] ?? 0);
  return chartHost((w) => barChart(vals, labels, "#7a6a3a", 1, w));
}

// --- main render ------------------------------------------------------------
let wired = false;
let inFlight = false;

export async function renderTrends(container: HTMLElement): Promise<void> {
  // Build the persistent head (title + range selector + export) once.
  if (!container.querySelector(".trend-head")) {
    container.innerHTML = `<div class="trend-head"><h2>Trends</h2>
      <nav class="range" aria-label="time range"></nav>
      <a class="export" href="/api/export.csv" download>Export CSV ↓</a></div>
      <div class="trend-grid"><p class="loading">Loading analytics…</p></div>`;
    const range = container.querySelector(".range") as HTMLElement;
    for (const r of RANGES) {
      const b = document.createElement("button");
      b.textContent = r.label;
      b.className = r.days === rangeDays ? "active" : "";
      b.addEventListener("click", () => {
        rangeDays = r.days;
        for (const c of range.children) c.classList.remove("active");
        b.classList.add("active");
        void draw(container);
      });
      range.append(b);
    }
  }
  // Clickable species names (delegated, attached once).
  if (!wired) {
    wired = true;
    const open = (t: EventTarget | null) => {
      const lnk = (t as HTMLElement | null)?.closest?.("[data-sci]") as HTMLElement | null;
      const sci = lnk?.dataset.sci;
      if (sci) location.hash = "#sci=" + encodeURIComponent(sci);
    };
    container.addEventListener("click", (e) => open(e.target));
    container.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).matches?.("[data-sci]")) {
        e.preventDefault();
        open(e.target);
      }
    });
  }
  await draw(container);
}

async function draw(container: HTMLElement): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const grid = container.querySelector(".trend-grid") as HTMLElement;
  try {
    const [daily, richness, diel, cooc, anoms, species] = await Promise.all([
      statsDaily(rangeDays),
      statsRichness(rangeDays),
      statsDiel(rangeDays, 12),
      statsCooccurrence(rangeDays, 10),
      statsAnomalies(Math.min(rangeDays, 365)),
      listSpecies(),
    ]);

    const totalCalls = daily.daily.reduce((s, d) => s + d.count, 0);
    const busiestHour = diel.total.indexOf(Math.max(...diel.total));
    const busiestDay = daily.daily.reduce((m, d) => (d.count > m.count ? d : m), { date: "", count: -1 });
    const newCount = anoms.items.filter((a) => a.type === "new").length;

    grid.innerHTML = "";
    grid.append(
      card(
        "Overview",
        statTiles([
          { k: "calls", v: totalCalls.toLocaleString() },
          { k: "species (life list)", v: String(species.species.length) },
          { k: "busiest hour", v: diel.total.some((n) => n > 0) ? `${hourLabel(busiestHour)}–${hourLabel((busiestHour + 1) % 24)}` : "—" },
          { k: "busiest day", v: busiestDay.count >= 0 ? fmtDate(Date.parse(`${busiestDay.date}T12:00:00Z`) / 1000) : "—", sub: busiestDay.count >= 0 ? `${busiestDay.count} calls` : "" },
          { k: "new this range", v: String(newCount) },
        ]),
        true,
      ),
      dielCard(diel.species),
      card(
        "Calls by hour (by species)",
        diel.species.length ? stackedHours(diel.species) : empty("No calls in this range."),
        true,
      ),
      card(
        "Heard together (co-occurrence)",
        cooc.species.length >= 2 ? coocMatrix(cooc.species, cooc.pairs) : empty("Not enough data yet."),
        true,
      ),
      card(
        "New & notable",
        anomaliesTable(anoms.items),
        true,
      ),
      card(
        "Detections per day",
        daily.daily.length
          ? chartHost((w) => lineChart(daily.daily.map((d) => ({ label: d.date, value: d.count })), "#8a5a2b", w))
          : empty("No detections yet."),
      ),
      card(
        "Species richness per day",
        richness.richness.length
          ? chartHost((w) => lineChart(richness.richness.map((d) => ({ label: d.date, value: d.species })), "#4a8a3d", w))
          : empty("No species yet."),
      ),
      card(
        "Life-list growth",
        species.species.length ? lifeList(species.species) : empty("No species yet."),
      ),
      card(
        "Activity calendar",
        daily.daily.length ? calendar(daily.daily) : empty("No detections yet."),
        true,
      ),
      card(
        "By day of week",
        daily.daily.length ? dayOfWeek(daily.daily) : empty("No detections yet."),
      ),
      card(
        "Top species",
        daily.top_species.length ? topList(daily.top_species) : empty("No species yet."),
      ),
    );
  } catch {
    grid.innerHTML = `<p class="loading">Couldn't load analytics.</p>`;
  } finally {
    inFlight = false;
  }
}

function empty(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "loading";
  p.textContent = text;
  return p;
}
