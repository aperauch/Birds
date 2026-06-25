// Alternate main-page layouts: photo "cards" and a compact "list".
//
// Both reuse the same SpeciesAgg data and the collage's `imageFor` (so they
// honour the Photo/Data art-style toggle), render into the shared #collage
// container, and open the species modal on click. They rebuild their innerHTML
// on each render (cheap at this scale) but preserve scroll position so a live
// detection re-render never yanks the viewport.
import type { SpeciesAgg } from "./types";
import type { CollageCtx } from "./collage";
import { imgURL } from "./img";

type OpenFn = (sci: string) => void;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
const escapeAttr = escapeHtml;

// Deterministic per-species hue for the no-photo placeholder (matches collage).
function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

// background-image style + a noimg flag for the placeholder gradient.
// NOTE: this string goes into a double-quoted HTML `style="…"` attribute, so the
// url() MUST use single quotes — double quotes would close the attribute early
// and silently drop the image (the collage avoids this by setting
// el.style.backgroundImage via the DOM API instead of an HTML string).
// Render the thumbnail as a lazy <img> (so off-screen rows/cards don't fetch
// until scrolled into view), or a coloured placeholder when there's no photo.
function thumbHtml(ctx: CollageCtx, a: SpeciesAgg, width: number): string {
  const { url } = ctx.imageFor(a);
  if (url) {
    const src = escapeAttr(imgURL(url, width) ?? url);
    return `<img class="thumb" loading="lazy" decoding="async" src="${src}" alt="" />`;
  }
  return `<span class="thumb noimg" style="--hue:${hue(a.sci_name)}"></span>`;
}

// One delegated click handler per render: open the species whose card/row was
// clicked (cards/rows are <button>s carrying data-sci, so Enter/Space work too).
function bindOpen(container: HTMLElement, onOpen: OpenFn): void {
  container.onclick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-sci]");
    const sci = el?.dataset.sci;
    if (sci) onOpen(sci);
  };
}

export function renderCards(
  container: HTMLElement,
  aggs: SpeciesAgg[],
  ctx: CollageCtx,
  onOpen: OpenFn,
): void {
  const top = container.scrollTop;
  const cards = aggs
    .map((a) => {
      return `<button class="card" data-sci="${escapeAttr(a.sci_name)}" aria-label="${escapeAttr(a.com_name)}, ${plural(a.count, "call")}">
        ${thumbHtml(ctx, a, 320)}
        <span class="cap">
          <span class="nm">${escapeHtml(a.com_name)}</span>
          <span class="meta"><span class="n">${plural(a.count, "call")}</span><span class="rt">${relTime(a.last_ts)}</span></span>
        </span>
      </button>`;
    })
    .join("");
  container.innerHTML = `<div class="cards-grid">${cards}</div>`;
  bindOpen(container, onOpen);
  container.scrollTop = top;
}

export function renderList(
  container: HTMLElement,
  aggs: SpeciesAgg[],
  ctx: CollageCtx,
  onOpen: OpenFn,
): void {
  const top = container.scrollTop;
  const rows = aggs
    .map((a) => {
      return `<button class="row" data-sci="${escapeAttr(a.sci_name)}" aria-label="${escapeAttr(a.com_name)}, ${plural(a.count, "call")}">
        ${thumbHtml(ctx, a, 128)}
        <span class="who"><span class="nm">${escapeHtml(a.com_name)}</span><span class="sci">${escapeHtml(a.sci_name)}</span></span>
        <span class="right"><span class="n">${plural(a.count, "call")}</span><span class="rt">${relTime(a.last_ts)}</span></span>
      </button>`;
    })
    .join("");
  container.innerHTML = `<div class="list">${rows}</div>`;
  bindOpen(container, onOpen);
  container.scrollTop = top;
}

/** Scroll a card/row into view and pulse it (ticker-chip click in cards/list). */
export function highlightInContainer(container: HTMLElement, sci: string): void {
  const sel = `[data-sci="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(sci) : sci}"]`;
  const el = container.querySelector<HTMLElement>(sel);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("hl");
  void el.offsetWidth; // restart the pulse animation
  el.classList.add("hl");
}
