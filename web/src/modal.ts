import { speciesDetail, type PlumagePhoto, type PlumageSource } from "./api";
import type { SpeciesAgg } from "./types";
import { renderWaveform } from "./waveform";

// Deterministic per-species hue (same hashing as the collage tiles) used to
// tint the audio waveforms.
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

const el = () => document.getElementById("modal") as HTMLElement;

// Auto-advance timer for the plumage-photo carousel; cleared on close/switch.
let plumageTimer: number | undefined;
function clearPlumage(): void {
  if (plumageTimer !== undefined) {
    clearInterval(plumageTimer);
    plumageTimer = undefined;
  }
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Closing controls (×, Escape, backdrop click) navigate to the collage route
// rather than hiding the DOM directly. The router (applyRoute in main.ts) reacts
// by calling closeModal(), so the URL stays the single source of truth and the
// browser back button works for #sci= deep links.
// The element focused before the dialog opened, so focus can be restored on close.
let lastFocused: HTMLElement | null = null;

function dismiss(): void {
  if (location.hash.startsWith("#sci=")) location.hash = "#/";
  else closeModal();
}

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, a[href], audio, input, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((e) => !e.hasAttribute("disabled") && e.offsetParent !== null);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    dismiss();
    return;
  }
  // Trap Tab focus inside the dialog.
  if (e.key === "Tab") {
    const f = focusable(el());
    if (f.length === 0) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function onBackdrop(e: MouseEvent): void {
  if (e.target === el()) dismiss();
}

export function closeModal(): void {
  const m = el();
  if (m.hidden) return;
  clearPlumage();
  m.hidden = true;
  m.innerHTML = "";
  delete m.dataset.sci;
  m.removeAttribute("role");
  m.removeAttribute("aria-modal");
  m.removeAttribute("aria-label");
  document.documentElement.classList.remove("has-modal"); // unlock background scroll
  document.removeEventListener("keydown", onKey);
  m.removeEventListener("click", onBackdrop);
  lastFocused?.focus?.(); // return focus to the tile/card that opened it
  lastFocused = null;
}

export async function openModal(agg: SpeciesAgg): Promise<void> {
  const m = el();
  const wasOpen = !m.hidden;
  clearPlumage(); // a previous species' carousel timer must not outlive this open
  if (!wasOpen) {
    lastFocused = (document.activeElement as HTMLElement) ?? null;
    document.documentElement.classList.add("has-modal"); // lock background scroll
  }
  m.hidden = false;
  m.dataset.sci = agg.sci_name;
  m.setAttribute("role", "dialog");
  m.setAttribute("aria-modal", "true");
  m.setAttribute("aria-label", agg.com_name);
  m.innerHTML = `<div class="sheet"><button class="x" aria-label="Close">×</button>
    <div class="sheet-head">
      <h2>${escapeHtml(agg.com_name)}</h2>
      <p class="sci">${escapeHtml(agg.sci_name)}</p>
    </div>
    <div class="sheet-body"><p class="loading">Loading recordings…</p></div></div>`;
  m.querySelector(".x")?.addEventListener("click", dismiss);
  // The backdrop + key listeners live on persistent targets, so only bind them
  // when transitioning from closed -> open (avoids stacking on species switches).
  if (!wasOpen) {
    m.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  }
  (m.querySelector(".x") as HTMLElement | null)?.focus(); // move focus into the dialog

  try {
    const { species, recent, cub_url, plumage_photos, plumage_source } =
      await speciesDetail(agg.sci_name);
    if (m.dataset.sci !== agg.sci_name) return; // navigated away / switched species
    // Backfill the header from authoritative detail — a #sci= deep link may open
    // with a minimal agg whose com_name is just the scientific name.
    const h2 = m.querySelector(".sheet-head h2");
    const sciEl = m.querySelector(".sheet-head .sci");
    if (h2) h2.textContent = species.com_name;
    if (sciEl) sciEl.textContent = species.sci_name;
    m.setAttribute("aria-label", species.com_name);
    const clips = recent.filter((d) => d.clip_url).slice(0, 6);
    const hue = hueFor(species.sci_name);

    const body = m.querySelector(".sheet-body");
    if (!body) return;
    body.innerHTML = `
      <div class="meta">
        <span>${species.total_count} calls</span>
        <span>best ${(species.best_confidence * 100) | 0}%</span>
        <span>last ${fmtTime(species.last_seen)}</span>
      </div>
      ${renderPlumage(plumage_photos, plumage_source)}
      <div class="clips">
        ${
          clips.length
            ? clips
                .map(
                  (d) => `<figure class="clip">
              <canvas class="wave" data-clip="${escapeHtml(d.clip_url ?? "")}" data-hue="${hue}"></canvas>
              <figcaption>${fmtTime(d.ts)} · ${(d.confidence * 100) | 0}%</figcaption>
              <audio controls preload="none" src="${d.clip_url}"></audio>
            </figure>`,
                )
                .join("")
            : `<p class="loading">No archived recordings yet.</p>`
        }
      </div>
      <div class="links">
        ${species.wikipedia_url ? `<a href="${species.wikipedia_url}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}
        <a href="https://xeno-canto.org/explore?query=${encodeURIComponent(species.sci_name)}" target="_blank" rel="noopener">Reference calls ↗</a>
        ${species.ebird_url ? `<a href="${species.ebird_url}" target="_blank" rel="noopener">eBird ↗</a>` : ""}
        ${cub_url ? `<a href="${escapeHtml(cub_url)}" target="_blank" rel="noopener">Celebrate Urban Birds ↗</a>` : ""}
        <button type="button" class="share" data-share>Copy link</button>
      </div>`;
    initPlumage(body);
    // Copy a shareable deep link to this species.
    body.querySelector<HTMLButtonElement>("[data-share]")?.addEventListener("click", (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      const link = `${location.origin}/#sci=${encodeURIComponent(species.sci_name)}`;
      const done = (txt: string) => {
        const prev = btn.textContent;
        btn.textContent = txt;
        window.setTimeout(() => (btn.textContent = prev), 1500);
      };
      void navigator.clipboard
        ?.writeText(link)
        .then(() => done("Copied ✓"))
        .catch(() => done("Press ⌘C"));
    });
    // Paint an artistic waveform for each recording from its actual audio.
    body.querySelectorAll<HTMLCanvasElement>("canvas.wave").forEach((c) => {
      const url = c.dataset.clip;
      if (url) void renderWaveform(c, url, Number(c.dataset.hue) || 28);
    });
  } catch {
    if (m.dataset.sci !== agg.sci_name) return; // navigated away / switched species
    const body = m.querySelector(".sheet-body");
    if (body) body.innerHTML = `<p class="loading">Couldn't load details.</p>`;
  }
}

// Build the photo carousel markup (empty string when none exist). eBird/Macaulay
// and iNaturalist photos carry only a credit; CUB photos are curated plumages
// labelled by age/sex.
function renderPlumage(photos: PlumagePhoto[], source: PlumageSource): string {
  if (!photos.length) return "";
  const slides = photos
    .map((p) => {
      // CUB photos carry an age/sex label; eBird/iNaturalist ones only a credit.
      const main = p.label || p.credit;
      const sub = p.label && p.credit ? p.credit : "";
      return `<figure class="plumage-slide">
        <img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.label || "photo")}" loading="lazy" referrerpolicy="no-referrer" />
        <figcaption>${escapeHtml(main)}${sub ? ` <span>${escapeHtml(sub)}</span>` : ""}</figcaption>
      </figure>`;
    })
    .join("");
  const multi = photos.length > 1;
  const heading =
    source === "ebird" ? "eBird photos" : source === "obs" ? "Photos" : "Plumage photos";
  return `<div class="plumage">
    <div class="plumage-head">${heading}</div>
    <div class="plumage-viewport">
      <div class="plumage-track">${slides}</div>
      ${multi ? `<button class="plumage-nav prev" aria-label="previous photo">‹</button><button class="plumage-nav next" aria-label="next photo">›</button>` : ""}
    </div>
    ${multi ? `<div class="plumage-dots">${photos.map((_, i) => `<span${i === 0 ? ' class="on"' : ""}></span>`).join("")}</div>` : ""}
  </div>`;
}

// Wire up auto-advance + manual controls for the plumage carousel.
function initPlumage(root: ParentNode): void {
  const track = root.querySelector<HTMLElement>(".plumage-track");
  if (!track) return;
  const n = track.children.length;
  if (n <= 1) return;
  const dots = [...root.querySelectorAll<HTMLElement>(".plumage-dots span")];
  let i = 0;
  const go = (next: number): void => {
    i = (next + n) % n;
    track.style.transform = `translateX(-${i * 100}%)`;
    dots.forEach((d, k) => d.classList.toggle("on", k === i));
  };
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const start = (): void => {
    clearPlumage();
    if (reduceMotion) return; // respect the OS setting — manual controls still work
    plumageTimer = window.setInterval(() => go(i + 1), 3500);
  };
  root.querySelector(".plumage-nav.next")?.addEventListener("click", () => {
    go(i + 1);
    start(); // reset the timer after manual interaction
  });
  root.querySelector(".plumage-nav.prev")?.addEventListener("click", () => {
    go(i - 1);
    start();
  });
  dots.forEach((d, k) =>
    d.addEventListener("click", () => {
      go(k);
      start();
    }),
  );
  const wrap = root.querySelector<HTMLElement>(".plumage");
  wrap?.addEventListener("mouseenter", clearPlumage); // pause on hover
  wrap?.addEventListener("mouseleave", start);
  start();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
