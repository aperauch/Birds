// Deterministic per-species colour helpers, shared by the collage, cards/list,
// modal waveforms, and trends charts so a species keeps one hue everywhere.

/** Stable hue (0..359) hashed from a species' scientific name. */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/**
 * CSS colour for a species series. Saturation/lightness come from the
 * `--chart-s` / `--chart-l` theme tokens so series colours adapt to dark mode;
 * the fallbacks match the historical light-theme values. `""` is the "Other
 * species" bucket. NOTE: contains var() — apply via `style`, not an SVG
 * presentation attribute (attributes don't resolve custom properties).
 */
export function colorFor(sci: string): string {
  return sci
    ? `hsl(${hueFor(sci)} var(--chart-s, 60%) var(--chart-l, 45%))`
    : "var(--chart-other, #9b8e76)";
}
