// Shared mini audio player: one HTMLAudioElement for the whole app, docked as
// a small pill at the bottom of the viewport. Starting a new clip stops
// whatever was playing (including any bare <audio> a caller forgets to stop),
// and the dock persists across modal close / route changes so navigating away
// never interrupts playback.
import { escapeHtml, fmtClock } from "./format";

export interface PlayableClip {
  url: string;
  title: string; // e.g. species common name
  sub?: string; // e.g. a formatted timestamp
}

type Listener = (url: string | null, playing: boolean) => void;
const listeners = new Set<Listener>();

/** Subscribe to player state changes; call the returned function to unsubscribe. */
export function onPlayerChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(playing: boolean): void {
  for (const fn of listeners) fn(current?.url ?? null, playing);
}

let audio: HTMLAudioElement | undefined;
let dock: HTMLElement | undefined;
let current: PlayableClip | undefined;
let raf: number | undefined;

function els(d: HTMLElement) {
  return {
    toggle: d.querySelector<HTMLButtonElement>(".player-toggle")!,
    title: d.querySelector<HTMLElement>(".player-title")!,
    time: d.querySelector<HTMLElement>(".player-time")!,
    fill: d.querySelector<HTMLElement>(".player-bar i")!,
  };
}

function syncHeight(): void {
  const d = dock;
  const h = !d || d.hidden ? 0 : d.offsetHeight;
  document.documentElement.style.setProperty("--player-h", `${h}px`);
}

function ensureDock(): HTMLElement {
  if (dock) return dock;
  const d = document.createElement("div");
  d.id = "player";
  d.hidden = true;
  d.innerHTML = `
    <button type="button" class="player-toggle" aria-label="Play"></button>
    <span class="player-info">
      <span class="player-title"></span>
      <span class="player-time">0:00 / 0:00</span>
    </span>
    <button type="button" class="player-close" aria-label="Close player">×</button>
    <span class="player-bar"><i></i></span>
  `;
  document.body.append(d);
  dock = d;
  els(d).toggle.addEventListener("click", toggle);
  d.querySelector(".player-close")?.addEventListener("click", stop);
  window.addEventListener("resize", syncHeight);
  return d;
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "none";
  a.addEventListener("play", () => setPlayingUi(true));
  a.addEventListener("pause", () => setPlayingUi(false));
  a.addEventListener("ended", () => setPlayingUi(false));
  audio = a;
  return a;
}

function setPlayingUi(playing: boolean): void {
  const d = ensureDock();
  d.classList.toggle("playing", playing);
  els(d).toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  if (playing) {
    if (raf === undefined) raf = requestAnimationFrame(tick);
  } else if (raf !== undefined) {
    cancelAnimationFrame(raf);
    raf = undefined;
  }
  notify(playing);
}

function tick(): void {
  const a = ensureAudio();
  const { time, fill } = els(ensureDock());
  time.textContent = `${fmtClock(a.currentTime)} / ${fmtClock(a.duration)}`;
  fill.style.width = `${a.duration ? (a.currentTime / a.duration) * 100 : 0}%`;
  raf = requestAnimationFrame(tick);
}

/** Play a clip in the docked player. Re-toggles play/pause if it's already loaded. */
export function play(clip: PlayableClip): void {
  const a = ensureAudio();
  const d = ensureDock();
  const isSame = current?.url === clip.url && !d.hidden;
  current = clip;
  d.hidden = false;
  syncHeight();
  els(d).title.textContent = clip.sub ? `${clip.title} — ${clip.sub}` : clip.title;
  els(d).title.setAttribute("title", escapeHtml(els(d).title.textContent ?? ""));
  if (isSame) {
    if (a.paused) void a.play();
    else a.pause();
    return;
  }
  a.src = clip.url;
  a.currentTime = 0;
  void a.play();
}

export function toggle(): void {
  const a = ensureAudio();
  if (a.paused) void a.play();
  else a.pause();
}

export function stop(): void {
  const a = ensureAudio();
  a.pause();
  a.removeAttribute("src");
  current = undefined;
  if (dock) {
    dock.hidden = true;
    syncHeight();
  }
  notify(false);
}

/** Whether `url` is the currently loaded clip and actively playing. */
export function isPlaying(url: string): boolean {
  return !!audio && !audio.paused && !!dock && !dock.hidden && current?.url === url;
}

/** Playback fraction (0..1) for `url` if it's the loaded clip, else 0. Lets a
 *  caller (e.g. a spectrogram progress cursor) paint from the one shared
 *  audio element without the player exposing it directly. */
export function progress(url: string): number {
  if (!audio || current?.url !== url || !audio.duration) return 0;
  return audio.currentTime / audio.duration;
}
