// Artistic audio waveform.
//
// Renders a recorded clip as a symmetric, gradient-tinted bar waveform on a
// <canvas>, in place of a static spectrogram / stylised image. Fully client-side:
// fetches the (same-origin) clip, decodes it with the Web Audio API, reduces the
// samples to RMS buckets, and paints mirrored rounded bars coloured by a
// per-species hue.

let sharedCtx: AudioContext | undefined;
function audioContext(): AudioContext {
  if (!sharedCtx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

export async function renderWaveform(
  canvas: HTMLCanvasElement,
  url: string,
  hue: number,
): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const raw = await res.arrayBuffer();
    const audio = await audioContext().decodeAudioData(raw);
    if (!canvas.isConnected) return; // modal closed / switched species mid-decode
    paint(canvas, audio, hue);
  } catch {
    /* leave the canvas blank if the fetch or decode fails */
  }
}

// Reduce a channel to `bars` normalised (0..1) RMS amplitudes.
function buckets(audio: AudioBuffer, bars: number): number[] {
  const data = audio.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / bars));
  const out: number[] = [];
  let max = 1e-6;
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    const start = i * block;
    for (let j = 0; j < block; j++) {
      const v = data[start + j] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / block);
    out.push(rms);
    if (rms > max) max = rms;
  }
  return out.map((v) => v / max);
}

function paint(canvas: HTMLCanvasElement, audio: AudioBuffer, hue: number): void {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 280;
  const H = canvas.clientHeight || 88;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);

  const bars = Math.max(24, Math.min(96, Math.floor(W / 5)));
  const amp = buckets(audio, bars);
  const slot = W / bars;
  const barW = Math.max(2, slot * 0.55);
  const mid = H / 2;

  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, `hsl(${hue} 68% 60%)`);
  grad.addColorStop(0.5, `hsl(${hue} 72% 48%)`);
  grad.addColorStop(1, `hsl(${(hue + 26) % 360} 62% 42%)`);
  g.fillStyle = grad;

  for (let i = 0; i < bars; i++) {
    const h = Math.max(2, (amp[i] ?? 0) * (H * 0.9));
    const x = i * slot + (slot - barW) / 2;
    roundedBar(g, x, mid - h / 2, barW, h, barW / 2);
  }
}

function roundedBar(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
  g.fill();
}
