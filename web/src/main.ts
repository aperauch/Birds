import "./styles.css";
import { aggregateWindow, listSpecies, recent } from "./api";
import { highlightTile, renderCollage, resetCollage, setCaptionEl, type CollageCtx } from "./collage";
import { renderCards, renderList, highlightInContainer } from "./views";
import { closeModal, openModal } from "./modal";
import { renderTrends } from "./trends";
import { createDropdown, type DropdownHandle } from "./dropdown";
import { LiveFeed } from "./ws";
import type {
  Detection,
  SortMode,
  Species,
  SpeciesAgg,
  ViewMode,
  WireMessage,
} from "./types";

type WindowValue = "1h" | "12h" | "24h" | "7d" | "all";
const WINDOWS: { value: WindowValue; label: string; hours: number | null }[] = [
  { value: "1h", label: "1H", hours: 1 },
  { value: "12h", label: "12H", hours: 12 },
  { value: "24h", label: "24H", hours: 24 },
  { value: "7d", label: "7D", hours: 168 },
  { value: "all", label: "All", hours: null },
];

// Inline SVG glyphs for the Layout toggle (stroke = currentColor so they inherit
// the button's ink/active colour). 24x24 viewBox, rounded joins.
const SVG = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_COLLAGE = SVG(
  '<rect x="3" y="3" width="8" height="18" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
);
const ICON_CARDS = SVG(
  '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
);
const ICON_LIST = SVG(
  '<rect x="3" y="4.5" width="4" height="4" rx="1"/><line x1="9.5" y1="6.5" x2="21" y2="6.5"/><rect x="3" y="10" width="4" height="4" rx="1"/><line x1="9.5" y1="12" x2="21" y2="12"/><rect x="3" y="15.5" width="4" height="4" rx="1"/><line x1="9.5" y1="17.5" x2="21" y2="17.5"/>',
);
const ICON_SUN = SVG(
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
);
const ICON_MOON = SVG('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>');

const VIEWS: { value: ViewMode; label: string; title: string; icon: string }[] = [
  { value: "collage", label: "Collage", title: "Packed collage", icon: ICON_COLLAGE },
  { value: "cards", label: "Cards", title: "Photo cards", icon: ICON_CARDS },
  { value: "list", label: "List", title: "Compact list", icon: ICON_LIST },
];

const SORTS: { value: SortMode; label: string; title: string }[] = [
  { value: "recent", label: "Recent", title: "Most recently heard" },
  { value: "frequent", label: "Frequent", title: "Most calls" },
  { value: "alpha", label: "A–Z", title: "Alphabetical" },
];

const barEl = document.getElementById("bar") as HTMLElement;
const collageEl = document.getElementById("collage") as HTMLElement;
const collageNameEl = document.getElementById("collage-name") as HTMLElement;
const trendsEl = document.getElementById("trends") as HTMLElement;
const viewLinkEl = document.getElementById("view-link") as HTMLAnchorElement;
const tickerEl = document.getElementById("ticker") as HTMLElement;
const controlsEl = document.getElementById("controls") as HTMLElement;
const windowsEl = document.getElementById("windows") as HTMLElement;
const viewsEl = document.getElementById("views") as HTMLElement;
const sortsEl = document.getElementById("sorts") as HTMLElement;
const connEl = document.getElementById("conn") as HTMLElement;
const speciesCountEl = document.getElementById("species-count") as HTMLElement;
const detectionCountEl = document.getElementById("detection-count") as HTMLElement;
const emptyEl = document.getElementById("empty") as HTMLElement;
const searchEl = document.getElementById("search") as HTMLInputElement;
const themeBtnEl = document.getElementById("theme-btn") as HTMLButtonElement;
const liveStatusEl = document.getElementById("live-status") as HTMLElement;

// The collage shows the selected bird's name in this caption (under the photos)
// rather than painting a label over each tile.
setCaptionEl(collageNameEl);

let query = ""; // species search filter

let windowHours: number | null = readWindow();
let viewMode: ViewMode = readView();
let sortMode: SortMode = readSort();
let tickerExpanded = false;

// Header dropdown handles (created in buildControls).
let sortDD: DropdownHandle<SortMode> | undefined;

// Sensor liveness: the dot is green only while the Pi is POSTing detections. If
// nothing arrives for 12h (e.g. the mic is unplugged / Pi stops hearing audio),
// the sensor is marked offline regardless of whether the dashboard's own live
// feed is still connected.
const SENSOR_OFFLINE_S = 12 * 60 * 60;
let lastDetectionTs = 0; // unix seconds of the most recent detection we've seen
let wsConnected = false; // dashboard <-> edge live-feed WebSocket state
const speciesIndex = new Map<string, Species>();
const aggs = new Map<string, SpeciesAgg>();
const recentTicker: Detection[] = [];
// Detection ids counted incrementally since the last aggregate snapshot, so the
// WebSocket feed and polling fallback never double-count the same detection.
const seenIds = new Set<string>();
// Timestamp of the last aggregate snapshot. Only detections newer than this are
// added incrementally (older ones are already included in the snapshot counts).
let aggAsOf = 0;

function readView(): ViewMode {
  const v = localStorage.getItem("birds.view");
  return v === "cards" || v === "list" ? v : "collage";
}

function readSort(): SortMode {
  const v = localStorage.getItem("birds.sort");
  return v === "frequent" || v === "alpha" ? v : "recent";
}

// Restore the saved time window (stored as its value, e.g. "7d"); 24h default.
function readWindow(): number | null {
  const match = WINDOWS.find((w) => w.value === localStorage.getItem("birds.window"));
  return match ? match.hours : 24;
}

// Species ordered for the cards/list views. Collage packs by count internally,
// so this ordering only drives cards/list.
function sortedAggs(): SpeciesAgg[] {
  const arr = [...aggs.values()];
  if (sortMode === "frequent") {
    arr.sort((a, b) => b.count - a.count || b.last_ts - a.last_ts || a.com_name.localeCompare(b.com_name));
  } else if (sortMode === "alpha") {
    arr.sort((a, b) => a.com_name.localeCompare(b.com_name));
  } else {
    arr.sort((a, b) => b.last_ts - a.last_ts || b.count - a.count || a.com_name.localeCompare(b.com_name));
  }
  return arr;
}

// Search filter applied to every view (matches common or scientific name).
function matchesQuery(a: SpeciesAgg): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return a.com_name.toLowerCase().includes(q) || a.sci_name.toLowerCase().includes(q);
}

// --- theme (light / dark / auto) -------------------------------------------
function effectiveTheme(): "light" | "dark" {
  const stored = localStorage.getItem("birds.theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(): void {
  const stored = localStorage.getItem("birds.theme");
  const root = document.documentElement;
  if (stored === "light" || stored === "dark") root.setAttribute("data-theme", stored);
  else root.removeAttribute("data-theme"); // follow the OS
  const eff = effectiveTheme();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", eff === "dark" ? "#17130e" : "#f5efe0");
  // Show the icon for the action the click performs (switch to the other theme).
  themeBtnEl.innerHTML = eff === "dark" ? ICON_SUN : ICON_MOON;
  const label = eff === "dark" ? "Switch to light mode" : "Switch to dark mode";
  themeBtnEl.setAttribute("aria-label", label);
  themeBtnEl.title = label;
}

function toggleTheme(): void {
  localStorage.setItem("birds.theme", effectiveTheme() === "dark" ? "light" : "dark");
  applyTheme();
}

function windowFrom(): number {
  if (windowHours === null) return 0;
  return Math.floor(Date.now() / 1000) - windowHours * 3600;
}

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: number | undefined;
  return ((...args: never[]) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

// Pull cached art references from the species index onto a live agg.
function applySpecies(a: SpeciesAgg): boolean {
  const s = speciesIndex.get(a.sci_name);
  if (!s) return false;
  const photo = s.photo_url ?? a.photo_url;
  const flux = s.flux_perched_url ?? s.flux_flight_url ?? a.flux_url;
  const cut = s.flux_perched_cut_url ?? s.flux_flight_cut_url ?? a.cut_url;
  const changed = photo !== a.photo_url || flux !== a.flux_url || cut !== a.cut_url;
  a.photo_url = photo;
  a.flux_url = flux;
  a.cut_url = cut;
  return changed;
}

function bump(d: Detection): void {
  const cur = aggs.get(d.sci_name);
  if (cur) {
    cur.count += 1;
    if (d.ts >= cur.last_ts) {
      cur.last_ts = d.ts;
      cur.last_id = d.id;
      if (d.art_url) cur.art_url = d.art_url;
    }
    cur.best_conf = Math.max(cur.best_conf, d.confidence);
    applySpecies(cur);
  } else {
    const a: SpeciesAgg = {
      sci_name: d.sci_name,
      com_name: d.com_name,
      count: 1,
      last_ts: d.ts,
      best_conf: d.confidence,
      photo_url: null,
      flux_url: null,
      cut_url: null,
      art_url: d.art_url ?? null,
      last_id: d.id,
    };
    applySpecies(a);
    aggs.set(d.sci_name, a);
  }
}

// Resolve the tile background: reference photo, falling back to the
// illustration. Tiles are rectangular, so no silhouette mask is needed.
const collageCtx: CollageCtx = {
  imageFor(a: SpeciesAgg) {
    return { url: a.photo_url || a.flux_url, cut: false };
  },
};

function updateCounts(): void {
  let total = 0;
  for (const a of aggs.values()) total += a.count;
  speciesCountEl.textContent = `${aggs.size} species`;
  detectionCountEl.textContent = `${total} calls`;
  emptyEl.hidden = aggs.size > 0;
}

// Tiles open the species modal via the URL so the view is deep-linkable and
// shareable (#sci=<scientific name>). applyRoute() reacts to the hash change.
function navigateToSpecies(sci: string): void {
  location.hash = "#sci=" + encodeURIComponent(sci);
}

// Resolve a SpeciesAgg for a #sci= deep link: prefer the live window aggregate,
// fall back to the cached species index, and finally a minimal placeholder that
// the modal's own detail fetch fills in.
function aggForSci(sci: string): SpeciesAgg {
  const live = aggs.get(sci);
  if (live) return live;
  const s = speciesIndex.get(sci);
  if (s) {
    return {
      sci_name: s.sci_name,
      com_name: s.com_name,
      count: s.total_count,
      last_ts: s.last_seen,
      best_conf: s.best_confidence,
      photo_url: s.photo_url,
      flux_url: s.flux_perched_url ?? s.flux_flight_url,
      cut_url: s.flux_perched_cut_url ?? s.flux_flight_cut_url,
      art_url: null,
      last_id: "",
    };
  }
  return {
    sci_name: sci,
    com_name: sci,
    count: 0,
    last_ts: 0,
    best_conf: 0,
    photo_url: null,
    flux_url: null,
    cut_url: null,
    art_url: null,
    last_id: "",
  };
}

// Tracks which view the #collage container currently holds, so a view switch
// can wipe the old DOM (and the collage's cached tile state) exactly once.
let renderedView: ViewMode | null = null;

const repack = debounce(() => {
  if (renderedView !== viewMode) {
    collageEl.innerHTML = "";
    collageEl.onclick = null;
    resetCollage();
    renderedView = viewMode;
  }
  collageEl.className = `mode-${viewMode}`;
  if (viewMode === "collage") {
    renderCollage(
      collageEl,
      [...aggs.values()].filter(matchesQuery),
      collageCtx,
      (a) => navigateToSpecies(a.sci_name),
    );
  } else if (viewMode === "cards") {
    renderCards(collageEl, sortedAggs().filter(matchesQuery), collageCtx, navigateToSpecies);
  } else {
    renderList(collageEl, sortedAggs().filter(matchesQuery), collageCtx, navigateToSpecies);
  }
  updateCounts();
}, 120);

// The header is fixed and wraps onto multiple rows on small screens, so the
// scrollable cards/list views need their top padding to match its live height.
function syncBarHeight(): void {
  document.documentElement.style.setProperty("--bar-h", `${barEl.offsetHeight}px`);
}

// Sorting only affects cards/list. Rather than removing the control (which used
// to shift the whole toolbar), keep it in place and just disable it in collage.
function syncControls(): void {
  sortDD?.setDisabled(viewMode === "collage", "Sorting applies to Cards & List");
  syncBarHeight();
}

function chipTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// The ticker collapses to just the most-recent chip. Chips are rendered oldest
// -> newest so the newest sits at the bottom anchor and history expands upward.
function renderTicker(): void {
  const items = recentTicker.slice(0, 12); // newest .. oldest
  const hidden = Math.max(0, items.length - 1);
  tickerEl.classList.toggle("expanded", tickerExpanded);
  tickerEl.innerHTML = items
    .slice()
    .reverse() // oldest .. newest (newest last = bottom)
    .map((d) => {
      const newest = d === items[0];
      let tog = "";
      if (newest) {
        tog = tickerExpanded
          ? `<i class="chip-tog" data-tog="1" title="Collapse">▾</i>`
          : hidden > 0
            ? `<i class="chip-tog" data-tog="1" title="Show ${hidden} more">${hidden}</i>`
            : "";
      }
      return `<button class="chip${newest ? " newest" : ""}" data-sci="${escapeAttr(d.sci_name)}">
        <b>${escapeHtml(d.com_name)}</b><span>${chipTime(d.ts)}</span>${tog}</button>`;
    })
    .join("");
}

// Insert a detection into the "latest 12" ticker, deduped by id. Returns whether
// the visible list changed (so callers can re-render once per batch).
function addToTicker(d: Detection): boolean {
  if (recentTicker.some((x) => x.id === d.id)) return false;
  recentTicker.push(d);
  recentTicker.sort((a, b) => b.ts - a.ts);
  if (recentTicker.length > 12) recentTicker.length = 12;
  return recentTicker.some((x) => x.id === d.id);
}

// Gate aggregate counting so each detection id is counted at most once across
// the WebSocket feed + polling fallback (bounded; loadWindow reseeds it).
function takeNew(id: string): boolean {
  if (seenIds.has(id)) return false;
  if (seenIds.size > 20000) seenIds.clear();
  seenIds.add(id);
  return true;
}

// Single entry point for a detection from any source (WS or poll). Updates the
// ticker (always) and the windowed aggregates (deduped, window-filtered).
function handleDetection(d: Detection): { ticker: boolean; agg: boolean; newSpecies: boolean } {
  noteDetectionTs(d.ts); // sensor liveness ignores the time-window filter
  const ticker = addToTicker(d);
  let agg = false;
  let newSpecies = false;
  // Count only detections newer than the last snapshot (older ones are already
  // in the aggregate), deduped across the WS feed + polling fallback.
  if (d.ts >= aggAsOf && d.ts >= windowFrom() && takeNew(d.id)) {
    newSpecies = !aggs.has(d.sci_name);
    bump(d);
    agg = true;
  }
  return { ticker, agg, newSpecies };
}

// Apply a batch of detections and refresh whatever changed, once.
function applyDetections(list: Detection[]): void {
  const prevNewest = recentTicker[0]?.id ?? "";
  let ticker = false;
  let agg = false;
  let newSpecies = false;
  for (const d of list) {
    const r = handleDetection(d);
    ticker = ticker || r.ticker;
    agg = agg || r.agg;
    newSpecies = newSpecies || r.newSpecies;
  }
  if (ticker) {
    renderTicker();
    const top = recentTicker[0];
    if (top && top.id !== prevNewest) {
      tickerEl.querySelector(".chip.newest")?.classList.add("flash");
      liveStatusEl.textContent = `${top.com_name} heard`; // announced to screen readers
    }
  }
  if (agg) repack();
  if (newSpecies) window.setTimeout(() => void refreshSpeciesIndex(), 8000);
}

// Polling fallback: keeps the ticker + page updating even if the live WebSocket
// goes stale (tab backgrounded, machine sleep, network blip). Deduped by id so
// it never conflicts with the WS feed. Also re-evaluates sensor liveness.
async function pollLive(): Promise<void> {
  try {
    const { detections } = await recent(30);
    applyDetections(detections);
  } catch {
    /* transient */
  } finally {
    evaluateSensor();
  }
}

// Ticker interaction: collapsed -> any click expands; expanded -> the toggle
// badge collapses, any chip highlights its bird tile in the collage.
function onTickerClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const chip = target.closest(".chip") as HTMLElement | null;
  if (!chip) return;
  if (!tickerExpanded) {
    tickerExpanded = true;
    renderTicker();
    return;
  }
  if (target.closest("[data-tog]")) {
    tickerExpanded = false;
    renderTicker();
    return;
  }
  if (chip.dataset.sci) {
    if (viewMode === "collage") highlightTile(chip.dataset.sci);
    else highlightInContainer(collageEl, chip.dataset.sci);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
const escapeAttr = escapeHtml;

async function loadWindow(): Promise<void> {
  const to = Math.floor(Date.now() / 1000);
  aggs.clear();
  seenIds.clear(); // authoritative snapshot; live deltas dedupe against aggAsOf
  aggAsOf = to;
  const { species } = await aggregateWindow(windowFrom(), to);
  for (const s of species) {
    const a: SpeciesAgg = {
      sci_name: s.sci_name,
      com_name: s.com_name,
      count: s.count,
      last_ts: s.last_ts,
      best_conf: s.best_confidence,
      photo_url: null,
      flux_url: null,
      cut_url: null,
      art_url: null,
      last_id: "",
    };
    applySpecies(a);
    aggs.set(s.sci_name, a);
  }
  repack();
}

async function refreshSpeciesIndex(): Promise<void> {
  try {
    const { species } = await listSpecies();
    for (const s of species) speciesIndex.set(s.sci_name, s);
    // Backfill any tiles whose photo arrived after the first sighting.
    let changed = false;
    for (const a of aggs.values()) {
      if (applySpecies(a)) changed = true;
    }
    if (changed) repack();
  } catch {
    /* transient */
  }
}

function onMessage(msg: WireMessage): void {
  if (msg.type === "hello") applyDetections(msg.recent);
  else if (msg.type === "detection") applyDetections([msg.event]);
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

// "just now" / "23m ago" / "3h ago" / "2d ago".
function ageLabel(sec: number): string {
  if (sec < 90) return "just now";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Paint the connection dot from sensor liveness (green = a detection within the
// last 12h). The dashboard's WebSocket state only colours the tooltip, so a
// briefly-dropped feed never falsely flips a healthy sensor to offline.
function evaluateSensor(): void {
  const age = lastDetectionTs ? nowS() - lastDetectionTs : Infinity;
  const online = age < SENSOR_OFFLINE_S;
  connEl.classList.toggle("on", online);
  if (!lastDetectionTs) {
    connEl.title = wsConnected ? "No detections yet" : "Connecting…";
  } else {
    const base = online
      ? `Sensor live — last call ${ageLabel(age)}`
      : `Sensor offline — no calls in 12h (last ${ageLabel(age)})`;
    connEl.title = wsConnected ? base : `${base} · reconnecting…`;
  }
}

// Record the timestamp of a detection POST and re-evaluate liveness.
function noteDetectionTs(ts: number): void {
  if (ts > lastDetectionTs) lastDetectionTs = ts;
  evaluateSensor();
}

function setStatus(connected: boolean): void {
  wsConnected = connected;
  evaluateSensor();
}

// Layout is the primary control, so it stays a glanceable one-tap segmented
// control (all options visible at once).
// Switch layout (used by the buttons AND the 1/2/3 keyboard shortcuts).
function setView(v: ViewMode): void {
  if (v === viewMode) return;
  viewMode = v;
  localStorage.setItem("birds.view", v);
  for (const c of viewsEl.children) {
    c.classList.toggle("active", (c as HTMLElement).dataset.view === v);
  }
  syncControls();
  repack();
}

function buildViewPicker(): void {
  viewsEl.innerHTML = "";
  for (const v of VIEWS) {
    const b = document.createElement("button");
    b.dataset.view = v.value;
    b.innerHTML = v.icon;
    b.title = v.title;
    b.setAttribute("aria-label", v.label);
    b.className = v.value === viewMode ? "active" : "";
    b.addEventListener("click", () => setView(v.value));
    viewsEl.appendChild(b);
  }
}

// The single-value selectors (time window, sort) are fixed-width dropdowns so
// the toolbar never reflows. Sort is always present but disabled in collage
// (where ordering has no visible effect). All selections persist to localStorage
// so they're restored on the next visit.
function buildControls(): void {
  buildViewPicker();

  const windowDD = createDropdown<WindowValue>({
    name: "Time window",
    minWidth: "3.4rem",
    value: WINDOWS.find((w) => w.hours === windowHours)?.value ?? "24h",
    options: WINDOWS.map((w) => ({ value: w.value, label: w.label })),
    onChange: (v) => {
      windowHours = WINDOWS.find((w) => w.value === v)?.hours ?? 24;
      localStorage.setItem("birds.window", v);
      void loadWindow();
    },
  });
  windowsEl.replaceChildren(windowDD.el);

  sortDD = createDropdown<SortMode>({
    name: "Sort",
    minWidth: "5.4rem",
    value: sortMode,
    options: SORTS.map((s) => ({ value: s.value, label: s.label, title: s.title })),
    onChange: (v) => {
      sortMode = v;
      localStorage.setItem("birds.sort", v);
      repack();
    },
  });
  sortsEl.replaceChildren(sortDD.el);
}

// Minimal hash router: analytics (#/trends), a species deep link
// (#sci=<scientific name>) that opens the detail modal over the collage, or the
// default collage (#/). The modal is an overlay, so #sci= keeps the collage view.
function applyRoute(): void {
  const hash = location.hash;
  let sci: string | null = null;
  if (hash.startsWith("#sci=")) {
    try {
      sci = decodeURIComponent(hash.slice(5));
    } catch {
      sci = null; // malformed escape sequence in the URL
    }
  }
  const trends = hash === "#/trends";

  trendsEl.hidden = !trends;
  collageEl.style.display = trends ? "none" : "";
  tickerEl.style.display = trends ? "none" : "";
  controlsEl.style.display = trends ? "none" : "";
  syncControls(); // sort enabled-state + bar height
  viewLinkEl.textContent = trends ? "← Collage" : "Trends →";
  viewLinkEl.setAttribute("href", trends ? "#/" : "#/trends");
  if (trends) void renderTrends(trendsEl);

  if (sci) void openModal(aggForSci(sci));
  else closeModal();
}

// Register the caching service worker (speeds up repeat loads). Idempotent with
// the push registration in notify.ts (same script URL).
function registerServiceWorker(): void {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* SW is a progressive enhancement; ignore failures */
    });
  }
}

// A brief shimmer placeholder shown before the first data lands.
function renderSkeleton(): void {
  collageEl.className = "mode-cards";
  collageEl.innerHTML = `<div class="skeleton-grid">${Array.from({ length: 10 })
    .map(() => '<div class="skel card"></div>')
    .join("")}</div>`;
}

// Keyboard shortcuts: / focus search, 1/2/3 switch layout, t toggle Trends.
function setupShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
      if (e.key === "Escape") t.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") {
      e.preventDefault();
      searchEl.focus();
    } else if (e.key === "1") setView("collage");
    else if (e.key === "2") setView("cards");
    else if (e.key === "3") setView("list");
    else if (e.key === "t" || e.key === "T") {
      location.hash = location.hash === "#/trends" ? "#/" : "#/trends";
    }
  });
}

async function main(): Promise<void> {
  registerServiceWorker();
  applyTheme();
  themeBtnEl.addEventListener("click", toggleTheme);
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      if (!localStorage.getItem("birds.theme")) applyTheme();
    });
  searchEl.addEventListener("input", () => {
    query = searchEl.value.trim();
    repack();
  });
  setupShortcuts();
  buildControls();
  tickerEl.addEventListener("click", onTickerClick);
  window.addEventListener("hashchange", applyRoute);
  renderSkeleton();
  await refreshSpeciesIndex();
  await loadWindow();
  await pollLive(); // seed the ticker + sensor dot before first paint
  // Apply the initial route only after data is loaded, so a #sci= deep link can
  // resolve against the species index / window aggregates.
  applyRoute();
  // Header height settles after web fonts load; re-measure so the scroll views
  // and the collage's top offset (--bar-h) track it, then re-pack to re-center.
  syncBarHeight();
  if (document.fonts?.ready)
    void document.fonts.ready.then(() => {
      syncBarHeight();
      repack();
    });

  const feed = new LiveFeed(onMessage, setStatus);
  feed.connect();

  window.addEventListener(
    "resize",
    debounce(() => {
      syncBarHeight();
      repack();
    }, 150),
  );
  window.setInterval(() => void refreshSpeciesIndex(), 60000);
  // Live-update fallback: poll for new detections every 15s (updates the ticker
  // + page and re-evaluates the sensor dot) so the dashboard never needs a manual
  // refresh even if the WebSocket goes stale.
  window.setInterval(() => void pollLive(), 15000);
  // Catch up immediately when the tab refocuses or the network returns.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void pollLive();
  });
  window.addEventListener("online", () => void pollLive());
  // ALL/relative windows drift; refresh relative windows periodically.
  window.setInterval(() => {
    if (windowHours !== null) void loadWindow();
  }, 120000);
}

void main();
