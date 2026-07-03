// Day explorer — every detection on one Eastern calendar date, grouped by
// hour with a clickable activity strip. Route: #/day. Independent of the main
// collage's time-window/search state, same pattern as the Trends view's own
// range selector.
import { detectionsInWindow } from "./api";
import type { Detection } from "./types";
import { addDays, easternDateOf, easternDayBoundsUtc, easternMinutesOfDay } from "./analytics";
import { escapeHtml } from "./format";
import { imgURL } from "./img";
import { onPlayerChange, play } from "./player";

function todayEastern(): string {
  return easternDateOf(Math.floor(Date.now() / 1000));
}

let selectedDate = todayEastern();
let inFlight = false;
let wired = false;

function hourClock(h: number): string {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${h < 12 ? "AM" : "PM"}`;
}

function fmtHeaderDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function groupByHour(detections: Detection[]): Map<number, Detection[]> {
  const map = new Map<number, Detection[]>();
  for (const d of detections) {
    // Clamp guards the once-a-year 25-hour fall-back day, which would
    // otherwise produce a spurious 25th bucket; folding it into 11 PM is a
    // reasonable choice for the one extra hour.
    const h = Math.min(23, Math.floor(easternMinutesOfDay(d.ts) / 60));
    const arr = map.get(h) ?? [];
    arr.push(d);
    map.set(h, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.ts - b.ts);
  return map;
}

function activityStrip(byHour: Map<number, Detection[]>): string {
  const counts = Array.from({ length: 24 }, (_, h) => byHour.get(h)?.length ?? 0);
  const max = Math.max(1, ...counts);
  const bars = counts
    .map((n, h) => {
      const pct = n === 0 ? 3 : Math.max(6, Math.round((n / max) * 100));
      const label = `${hourClock(h)}: ${n} call${n === 1 ? "" : "s"}`;
      return `<button type="button" class="day-bar" data-hour="${h}" style="--h:${pct}%" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${n === 0 ? " disabled" : ""}></button>`;
    })
    .join("");
  return `<div class="day-strip">${bars}</div>`;
}

function hourGroupHtml(h: number, dets: Detection[]): string {
  const rows = dets
    .map((d) => {
      const time = new Date(d.ts * 1000).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
      const thumb = d.spectrogram_url
        ? `<img class="day-thumb" src="${escapeHtml(imgURL(d.spectrogram_url, 160) ?? d.spectrogram_url)}" alt="" loading="lazy" />`
        : `<span class="day-thumb noimg"></span>`;
      const playBtn = d.clip_url
        ? `<button type="button" class="day-play" data-play="${escapeHtml(d.clip_url)}" data-title="${escapeHtml(d.com_name)}" data-sub="${escapeHtml(time)}" aria-label="Play recording from ${escapeHtml(time)}">▶</button>`
        : `<span class="day-play noclip" aria-hidden="true"></span>`;
      return `<div class="day-row">
        ${thumb}
        <span class="day-time">${time}</span>
        <button type="button" class="day-sp" data-sci="${escapeHtml(d.sci_name)}">${escapeHtml(d.com_name)}</button>
        <span class="day-conf">${(d.confidence * 100) | 0}%</span>
        ${playBtn}
      </div>`;
    })
    .join("");
  return `<section class="day-hour" id="day-hour-${h}">
    <h3>${escapeHtml(hourClock(h))}</h3>
    <div class="day-rows">${rows}</div>
  </section>`;
}

function syncPlayButtons(url: string | null, playing: boolean): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".day-play[data-play]")) {
    const active = playing && btn.dataset.play === url;
    btn.classList.toggle("playing", active);
    btn.textContent = active ? "❚❚" : "▶";
  }
}

function wireOnce(container: HTMLElement): void {
  if (wired) return;
  wired = true;
  onPlayerChange(syncPlayButtons);
  container.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const bar = t.closest<HTMLElement>(".day-bar[data-hour]");
    if (bar) {
      container.querySelector(`#day-hour-${bar.dataset.hour}`)?.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
      return;
    }
    const playBtn = t.closest<HTMLElement>(".day-play[data-play]");
    if (playBtn?.dataset.play) {
      play({ url: playBtn.dataset.play, title: playBtn.dataset.title ?? "", sub: playBtn.dataset.sub });
      return;
    }
    const sp = t.closest<HTMLElement>("[data-sci]");
    if (sp?.dataset.sci) location.hash = "#sci=" + encodeURIComponent(sp.dataset.sci);
  });
}

function shiftDay(delta: number, container: HTMLElement): void {
  const next = addDays(selectedDate, delta);
  if (next > todayEastern()) return; // future disabled
  selectedDate = next;
  void draw(container);
}

export async function renderDay(container: HTMLElement): Promise<void> {
  if (!container.querySelector(".day-head")) {
    container.innerHTML = `
      <div class="day-head">
        <button type="button" class="day-nav prev" aria-label="Previous day">‹</button>
        <h2 class="day-date"></h2>
        <button type="button" class="day-nav next" aria-label="Next day">›</button>
      </div>
      <div class="day-body"><p class="loading">Loading…</p></div>`;
    container.querySelector(".day-nav.prev")?.addEventListener("click", () => shiftDay(-1, container));
    container.querySelector(".day-nav.next")?.addEventListener("click", () => shiftDay(1, container));
  }
  wireOnce(container);
  await draw(container);
}

async function draw(container: HTMLElement): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const head = container.querySelector(".day-date") as HTMLElement;
  const body = container.querySelector(".day-body") as HTMLElement;
  const nextBtn = container.querySelector<HTMLButtonElement>(".day-nav.next");
  const today = todayEastern();
  head.textContent = selectedDate === today ? `Today — ${fmtHeaderDate(selectedDate)}` : fmtHeaderDate(selectedDate);
  nextBtn?.toggleAttribute("disabled", selectedDate >= today);
  body.innerHTML = `<p class="loading">Loading…</p>`;
  try {
    const { from, to } = easternDayBoundsUtc(selectedDate);
    const { detections } = await detectionsInWindow(from, to);
    if (!detections.length) {
      body.innerHTML = `<p class="loading">No calls heard on this day.</p>`;
      return;
    }
    const byHour = groupByHour(detections);
    const groups = [...byHour.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([h, dets]) => hourGroupHtml(h, dets))
      .join("");
    body.innerHTML = `${activityStrip(byHour)}<div class="day-groups">${groups}</div>`;
  } catch {
    body.innerHTML = `<p class="loading">Couldn't load this day.</p>`;
  } finally {
    inFlight = false;
  }
}
