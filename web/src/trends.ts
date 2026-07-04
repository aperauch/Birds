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
  statsFirstLast,
  statsPunchcard,
  statsRichness,
  type Anomaly,
  type CoocPair,
  type CoocSpecies,
  type DielSpecies,
  type FirstLastDay,
  type SunDay,
} from "./api";
import type { Species } from "./types";
import { agoDays, escapeHtml, fmtDate, hourLabel } from "./format";
import { colorFor } from "./color";
import {
  addDays,
  computeRecords,
  easternMinutesOfDay,
  hhmm,
  pctDelta,
  shannonByDay,
  sparkSeries,
  speciesWeekDeltas,
  speciesWeekPair,
  trailingWeeks,
} from "./analytics";
import {
  barChart,
  chartHost,
  CHART_H as H,
  CHART_PAD as PAD,
  el,
  lineChart,
  spark,
  svg,
  title,
} from "./charts";

const RANGES: { label: string; days: number }[] = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "1Y", days: 365 },
  { label: "All", days: 3650 },
];
let rangeDays = 30;

// "All" uses a from=0 (epoch) query instead of clamping to the 3650-day
// sentinel used elsewhere, so the export genuinely covers every detection
// regardless of how old the data is.
function exportHref(days: number): string {
  const to = Math.floor(Date.now() / 1000);
  const from = days >= RANGES[RANGES.length - 1]!.days ? 0 : to - days * 86400;
  return `/api/export.csv?from=${from}&to=${to}`;
}

function card(titleText: string, body: SVGElement | HTMLElement, wide = false): HTMLElement {
  const c = document.createElement("section");
  c.className = wide ? "trend-card wide" : "trend-card";
  const h = document.createElement("h3");
  h.textContent = titleText;
  c.append(h, body);
  return c;
}

// The page groups its cards under a few section headings; the header offers
// matching jump chips. Buttons + scrollIntoView (never location.hash — that
// would knock the router off the #/trends route).
const SECTIONS: { id: string; label: string }[] = [
  { id: "t-overview", label: "Overview" },
  { id: "t-rhythm", label: "Daily rhythm" },
  { id: "t-species", label: "Species" },
  { id: "t-history", label: "History" },
];

function sectionHead(id: string): HTMLElement {
  const s = SECTIONS.find((x) => x.id === id)!;
  const h = document.createElement("h2");
  h.className = "trend-section";
  h.id = s.id;
  h.textContent = s.label;
  return h;
}

function sciSpan(sci: string, com: string): string {
  return `<span class="lnk" data-sci="${sci.replace(/"/g, "&quot;")}" role="link" tabindex="0">${escapeHtml(com)}</span>`;
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

interface SeriesRow {
  date: string;
  sci_name: string;
  com_name: string;
  count: number;
}

function sparklinesCard(
  rows: SeriesRow[],
  top: { sci_name: string; com_name: string; count: number }[],
  from: string,
  today: string,
  showDelta: boolean,
): HTMLElement {
  const deltas = speciesWeekDeltas(rows, today);
  const wrap = document.createElement("div");
  wrap.className = "sparks";
  for (const t of top.slice(0, 10)) {
    const rowEl = document.createElement("div");
    rowEl.className = "spark-row";
    const pair = deltas.get(t.sci_name);
    const pct = showDelta && pair ? pctDelta(pair.thisWeek, pair.lastWeek) : null;
    // Neutral ink for the deltas — more calls isn't "good", fewer isn't "bad".
    const deltaHtml =
      pct === null
        ? `<span class="delta"></span>`
        : `<span class="delta" title="calls this week vs last">${pct > 0 ? "▲" : pct < 0 ? "▼" : "◆"} ${Math.abs(pct)}%</span>`;
    rowEl.innerHTML = `${sciSpan(t.sci_name, t.com_name)}<span class="spark-host"></span><span class="spark-n">${t.count}</span>${deltaHtml}`;
    const values = sparkSeries(rows, t.sci_name, from, today);
    const sv = spark(values, colorFor(t.sci_name));
    title(sv, `${t.com_name} — ${t.count} calls, daily trend`);
    rowEl.querySelector(".spark-host")?.append(sv);
    wrap.append(rowEl);
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
        const bg = n === 0 ? "" : ` style="background:rgb(var(--heat) / ${(0.12 + 0.88 * (n / rowMax)).toFixed(3)})"`;
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

// --- weekday x hour punchcard -------------------------------------------------
// SQLite's %w is 0=Sun..6=Sat; reordered to Mon..Sun to match the existing
// "By day of week" bar chart.
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function punchcard(matrix: number[][]): HTMLElement {
  const max = Math.max(1, ...matrix.flat());
  const grid = document.createElement("div");
  grid.className = "punch";
  const head = document.createElement("div");
  head.className = "punch-row punch-hours";
  head.innerHTML = `<span class="punch-label"></span>${Array.from({ length: 24 })
    .map((_, h) => `<span class="punch-hr">${h % 6 === 0 ? hourLabel(h) : ""}</span>`)
    .join("")}`;
  grid.append(head);
  DOW_ORDER.forEach((dow, i) => {
    const row = document.createElement("div");
    row.className = "punch-row";
    const cells = (matrix[dow] ?? [])
      .map((n, h) => {
        if (n === 0) return `<span class="punch-cell"></span>`;
        // sqrt scaling keeps low-volume hours visibly non-zero.
        const pct = (14 + 82 * Math.sqrt(n / max)).toFixed(0);
        const label = `${DOW_LABELS[i]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${n} call${n === 1 ? "" : "s"}`;
        return `<span class="punch-cell"><i style="width:${pct}%;height:${pct}%" title="${escapeHtml(label)}"></i></span>`;
      })
      .join("");
    row.innerHTML = `<span class="punch-label">${DOW_LABELS[i]}</span>${cells}`;
    grid.append(row);
  });
  return grid;
}

// --- dawn chorus: first-call time-of-day per date, with a sunrise overlay ----
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function dawnChorusSvg(items: FirstLastDay[], sun: SunDay[] | undefined, w: number): SVGSVGElement {
  const s = svg(w, H);
  const iw = w - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const n = items.length;
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  // Fixed 4am-10am window: covers seasonal dawn-chorus drift without letting a
  // stray late "first call" (e.g. a quiet day) blow out the scale.
  const MIN_M = 240;
  const MAX_M = 600;
  const y = (min: number) => PAD.t + ih - ((clamp(min, MIN_M, MAX_M) - MIN_M) / (MAX_M - MIN_M)) * ih;
  s.append(el("line", { x1: PAD.l, y1: PAD.t + ih, x2: PAD.l + iw, y2: PAD.t + ih, class: "axis" }));
  s.append(el("line", { x1: PAD.l, y1: PAD.t, x2: PAD.l, y2: PAD.t + ih, class: "axis" }));
  for (const m of [MIN_M, (MIN_M + MAX_M) / 2, MAX_M]) {
    const t = el("text", { x: 2, y: y(m) + 3, class: "tick" });
    t.textContent = hhmm(m);
    s.append(t);
  }
  if (sun?.length) {
    const byDate = new Map(sun.map((d) => [d.date, d]));
    const pts = items.flatMap((it, i) => {
      const sd = byDate.get(it.date);
      return sd ? [{ x: x(i), y: y(easternMinutesOfDay(sd.sunrise)) }] : [];
    });
    if (pts.length) {
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      s.append(
        el("path", {
          d,
          style: "fill:none;stroke:var(--chart-line-3)",
          "stroke-width": 1.5,
          "stroke-dasharray": "3,3",
        }),
      );
    }
  }
  for (const [i, it] of items.entries()) {
    const min = easternMinutesOfDay(it.first_ts);
    const c = el("circle", { cx: x(i), cy: y(min), r: 3, style: "fill:var(--chart-line-1)" });
    title(c, `${it.date} — first call ${hhmm(min)}`);
    s.append(c);
  }
  return s;
}

function dawnChorusCard(items: FirstLastDay[], sun: SunDay[] | undefined): HTMLElement {
  const wrap = document.createElement("div");
  wrap.append(chartHost((w) => dawnChorusSvg(items, sun, w)));
  if (sun?.length) {
    const cap = document.createElement("p");
    cap.className = "chart-caption";
    cap.textContent = "Dashed line = sunrise";
    wrap.append(cap);
  }
  return wrap;
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
      // colorFor() contains var() — presentation attributes don't resolve
      // custom properties, so the fill must go through `style`.
      const r = el("rect", {
        x: PAD.l + h * bw + 0.5,
        y: yCursor,
        width: Math.max(1, bw - 1),
        height: segH,
        style: `fill:${colorFor(sp.sci_name)}`,
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
        const bg = v === 0 ? "" : ` style="background:rgb(var(--heat-2) / ${(0.12 + 0.88 * (v / max)).toFixed(3)})"`;
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
          ? `first seen ${agoDays(a.first_seen)}`
          : a.type === "returned"
            ? `back after ~${a.gap_days}d · last ${agoDays(a.last_seen)}`
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

// --- records & streaks --------------------------------------------------------
function recordsCard(
  daily: { date: string; count: number }[],
  rows: SeriesRow[],
  today: string,
): HTMLElement {
  const r = computeRecords(daily, rows, today);
  const tiles: { k: string; v: string; sub?: string }[] = [
    {
      k: "busiest day",
      v: r.busiest ? fmtDate(Date.parse(`${r.busiest.date}T12:00:00Z`) / 1000) : "—",
      sub: r.busiest ? `${r.busiest.count} calls` : "",
    },
    {
      k: "most diverse day",
      v: r.mostDiverse ? fmtDate(Date.parse(`${r.mostDiverse.date}T12:00:00Z`) / 1000) : "—",
      sub: r.mostDiverse ? `${r.mostDiverse.species} species` : "",
    },
    {
      k: "longest streak",
      v: r.longestStreak ? `${r.longestStreak.streak.len}d` : "—",
      sub: r.longestStreak ? r.longestStreak.com_name : "",
    },
    {
      k: "current streak",
      v: r.currentStreak ? `${r.currentStreak.len}d` : "—",
      sub: r.currentStreak ? r.currentStreak.com_name : "none active",
    },
  ];
  return statTiles(tiles);
}

// --- week vs week --------------------------------------------------------------
function weekTile(label: string, cur: number, prev: number): string {
  const pct = pctDelta(cur, prev);
  const sub =
    pct === null ? "no prior week" : `${pct > 0 ? "▲" : pct < 0 ? "▼" : "◆"} ${Math.abs(pct)}% vs last week`;
  return `<div class="tile-stat"><span class="v">${cur.toLocaleString()}</span><span class="k">${escapeHtml(label)}</span><span class="s">${escapeHtml(sub)}</span></div>`;
}

function weekOverWeekCard(
  daily: { date: string; count: number }[],
  rows: SeriesRow[],
  today: string,
  haveTwoWeeks: boolean,
): HTMLElement {
  if (!haveTwoWeeks) return empty("Needs two weeks of history to compare.");
  const calls = trailingWeeks(daily, today);
  const activeSpecies = speciesWeekPair(rows, today);
  const deltas = speciesWeekDeltas(rows, today);
  let newSpecies = 0;
  for (const pair of deltas.values()) if (pair.thisWeek > 0 && pair.lastWeek === 0) newSpecies += 1;
  const wrap = document.createElement("div");
  wrap.className = "trend-tiles";
  wrap.innerHTML =
    weekTile("calls this week", calls.thisWeek, calls.lastWeek) +
    weekTile("active species", activeSpecies.thisWeek, activeSpecies.lastWeek) +
    `<div class="tile-stat"><span class="v">${newSpecies}</span><span class="k">new this week</span></div>`;
  return wrap;
}

// --- diversity (Shannon H') ----------------------------------------------------
function diversityCard(rows: SeriesRow[]): HTMLElement {
  const points = shannonByDay(rows).map((d) => ({ label: d.date, value: d.h }));
  return chartHost((w) => lineChart(points, "var(--chart-line-2)", w));
}

// --- life-list growth (cumulative distinct species) -------------------------
function lifeList(species: Species[]): HTMLElement {
  const firsts = species
    .map((s) => s.first_seen)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  const points = firsts.map((ts, i) => ({ label: new Date(ts * 1000).toISOString().slice(0, 10), value: i + 1 }));
  return chartHost((w) => lineChart(points, "var(--chart-line-3)", w));
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
    cell.style.background = n === 0 ? "var(--line)" : `rgb(var(--heat) / ${a.toFixed(3)})`;
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
  return chartHost((w) => barChart(vals, labels, "var(--chart-line-4)", 1, w));
}

// --- main render ------------------------------------------------------------
let wired = false;
let inFlight = false;

export async function renderTrends(container: HTMLElement): Promise<void> {
  // Build the persistent head (title + range selector + export) once.
  if (!container.querySelector(".trend-head")) {
    container.innerHTML = `<div class="trend-head"><h2>Trends</h2>
      <nav class="range" aria-label="time range"></nav>
      <a class="export" href="${exportHref(rangeDays)}" download>Export CSV ↓</a>
      <nav class="jump" aria-label="sections"></nav></div>
      <div class="trend-grid"><p class="loading">Loading analytics…</p></div>`;
    const range = container.querySelector(".range") as HTMLElement;
    const exportLink = container.querySelector("a.export") as HTMLAnchorElement;
    // Refresh `to` to the actual click time even if the tab's been open a
    // while since the range was last changed.
    exportLink.addEventListener("click", () => {
      exportLink.href = exportHref(rangeDays);
    });
    for (const r of RANGES) {
      const b = document.createElement("button");
      b.textContent = r.label;
      b.className = r.days === rangeDays ? "active" : "";
      b.addEventListener("click", () => {
        rangeDays = r.days;
        for (const c of range.children) c.classList.remove("active");
        b.classList.add("active");
        exportLink.href = exportHref(rangeDays);
        void draw(container);
      });
      range.append(b);
    }
    const jump = container.querySelector(".jump") as HTMLElement;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    for (const s of SECTIONS) {
      const b = document.createElement("button");
      b.textContent = s.label;
      b.addEventListener("click", () => {
        container
          .querySelector(`#${s.id}`)
          ?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
      });
      jump.append(b);
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
    const [daily, richness, diel, cooc, anoms, species, punch, firstLast] = await Promise.all([
      statsDaily(rangeDays),
      statsRichness(rangeDays),
      statsDiel(rangeDays, 12),
      statsCooccurrence(rangeDays, 10),
      statsAnomalies(Math.min(rangeDays, 365)),
      listSpecies(),
      statsPunchcard(rangeDays),
      statsFirstLast(Math.min(rangeDays, 365)),
    ]);

    const totalCalls = daily.daily.reduce((s, d) => s + d.count, 0);
    const busiestHour = diel.total.indexOf(Math.max(...diel.total));
    const busiestDay = daily.daily.reduce((m, d) => (d.count > m.count ? d : m), { date: "", count: -1 });
    const newCount = anoms.items.filter((a) => a.type === "new").length;

    // Actual data genesis (earliest species.first_seen), independent of the
    // selected range — gates the week-over-week card and sparkline deltas so
    // they never compare against padding-zero history.
    const today = new Date().toISOString().slice(0, 10);
    const genesisTs = species.species.reduce((m, s) => Math.min(m, s.first_seen), Infinity);
    const genesisDate = Number.isFinite(genesisTs)
      ? new Date(genesisTs * 1000).toISOString().slice(0, 10)
      : today;
    const haveTwoWeeks = addDays(today, -13) >= genesisDate;

    grid.innerHTML = "";
    grid.append(
      sectionHead("t-overview"),
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
      card("Records & streaks", recordsCard(daily.daily, daily.series, today), true),
      card(
        "This week vs last week",
        weekOverWeekCard(daily.daily, daily.series, today, haveTwoWeeks),
        true,
      ),
      sectionHead("t-rhythm"),
      dielCard(diel.species),
      card(
        "Calls by hour (by species)",
        diel.species.length ? stackedHours(diel.species) : empty("No calls in this range."),
        true,
      ),
      card(
        "Weekly punchcard — Eastern time",
        punch.matrix.some((row) => row.some((n) => n > 0)) ? punchcard(punch.matrix) : empty("No calls in this range."),
        true,
      ),
      card(
        "Dawn chorus — first call of the day",
        firstLast.items.length ? dawnChorusCard(firstLast.items, firstLast.sun) : empty("No detections yet."),
        true,
      ),
      sectionHead("t-species"),
      card(
        "Species trends",
        daily.top_species.length
          ? sparklinesCard(daily.series, daily.top_species, daily.from, today, haveTwoWeeks)
          : empty("No species yet."),
        true,
      ),
      card(
        "Top species",
        daily.top_species.length ? topList(daily.top_species) : empty("No species yet."),
      ),
      card(
        "Life-list growth",
        species.species.length ? lifeList(species.species) : empty("No species yet."),
      ),
      card(
        "New & notable",
        anomaliesTable(anoms.items),
        true,
      ),
      card(
        "Heard together (co-occurrence)",
        cooc.species.length >= 2 ? coocMatrix(cooc.species, cooc.pairs) : empty("Not enough data yet."),
        true,
      ),
      sectionHead("t-history"),
      card(
        "Detections per day",
        daily.daily.length
          ? chartHost((w) => lineChart(daily.daily.map((d) => ({ label: d.date, value: d.count })), "var(--chart-line-1)", w))
          : empty("No detections yet."),
      ),
      card(
        "Species richness per day",
        richness.richness.length
          ? chartHost((w) => lineChart(richness.richness.map((d) => ({ label: d.date, value: d.species })), "var(--chart-line-2)", w))
          : empty("No species yet."),
      ),
      card(
        "Species diversity (Shannon)",
        daily.series.length ? diversityCard(daily.series) : empty("No detections yet."),
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
