import type { SpeciesAgg } from "./types";
import { imgURL } from "./img";
import { hueFor } from "./color";
import { layout } from "./packing";

export interface CollageCtx {
  // Resolved background for the active art style.
  imageFor(agg: SpeciesAgg): { url: string | null; cut: boolean };
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
      el.style.setProperty("--hue", String(hueFor(p.agg.sci_name)));
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
