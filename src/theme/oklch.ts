/** OKLCH colour math: pure, closed-form, and EXPORT CONTRACT - the perceptual gradient raster (`space: "oklch"`) interpolates through these functions, so the matrices/curves below are pinned by golden tests. Björn Ottosson's OKLab constants, sRGB (D65). */

export interface Oklch {
  l: number;
  c: number;
  h: number; // degrees, [0, 360)
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** #rgb/#rrggbb → [r,g,b] bytes. */
export function hexToBytes(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

export function bytesToHex([r, g, b]: [number, number, number]): string {
  const to = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** sRGB hex → OKLCH. */
export function hexToOklch(hex: string): Oklch {
  const [rb, gb, bb] = hexToBytes(hex);
  const r = srgbToLinear(rb / 255);
  const g = srgbToLinear(gb / 255);
  const b = srgbToLinear(bb / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb2);
  let h = (Math.atan2(bb2, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/** OKLCH → sRGB bytes, channel-clamped to the gamut (deterministic, no chroma search). */
export function oklchToBytes({ l: L, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const blue = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return [
    Math.round(clamp01(linearToSrgb(clamp01(r))) * 255),
    Math.round(clamp01(linearToSrgb(clamp01(g))) * 255),
    Math.round(clamp01(linearToSrgb(clamp01(blue))) * 255),
  ];
}

/** Interpolates two OKLCH colours: L/C linear, hue on the SHORTEST arc. An achromatic endpoint (c ≈ 0, hue is numerically meaningless) adopts the other side's hue so near-neutral stops don't drag through arbitrary hues. */
export function mixOklch(a: Oklch, b: Oklch, t: number): Oklch {
  const ACHROMATIC = 1e-4;
  let ha = a.h;
  let hb = b.h;
  if (a.c < ACHROMATIC) ha = hb;
  if (b.c < ACHROMATIC) hb = ha;
  let dh = hb - ha;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  let h = ha + dh * t;
  if (h < 0) h += 360;
  if (h >= 360) h -= 360;
  return { l: a.l + (b.l - a.l) * t, c: a.c + (b.c - a.c) * t, h };
}
