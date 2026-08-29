import type { ResolvedTextLook } from "./looks";

/** Pure styling maths for the SDF text looks (looks.ts names them, this file prices them): colour derivation, the gradient projection, the arc bend and the per-look troika prop values, all pure functions so the seams test without a GL context and preview/export agree byte-for-byte. */

// ── Contract constants (golden-pinned; changing any re-renders every project that uses the look pack) ──
/** gradient: colorB's derived stop, an sRGB channel scale of colorA. */
export const GRADIENT_B_DARKEN = 0.55;
/** neon: halo radius in em at intensity 1 (outlineBlur, the blur-in halo's slot). */
export const NEON_BLUR_EM = 0.25;
/** neon: halo opacity at intensity 1. */
export const NEON_HALO_OPACITY = 0.9;
/** neon: core fill lift toward white at intensity 1 (the slight core brighten). */
export const NEON_CORE_LIFT = 0.35;
/** offset-print: under-layer z push behind the main text (and behind chromatic's echoes), em. */
export const OFFSET_PRINT_Z_EM = 0.035;
/** frosted: SDF edge soften at intensity 1, em. */
export const FROSTED_SOFT_EM = 0.12;
/** frosted: SDF weight gain at intensity 1, em. */
export const FROSTED_WEIGHT_EM = 0.025;
/** frosted: the held cool band's centre (band-sweep u) and peak intensity at intensity 1. */
export const FROSTED_SHINE_U = 0.5;
export const FROSTED_SHINE_INTENSITY = 0.22;
/** frosted: the cool shine tint (a pale ice blue). */
export const FROSTED_SHINE_TINT = "#cfe4ff";

/** The look's primary colour: colorA, else the theme accent (the contract default). */
export function lookColorA(look: ResolvedTextLook, accent: string): string {
  return look.colorA ?? accent;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  if (h.length === 3) {
    return [
      Number.parseInt(h[0] + h[0], 16),
      Number.parseInt(h[1] + h[1], 16),
      Number.parseInt(h[2] + h[2], 16),
    ];
  }
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

function formatHex(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Scale a hex colour's sRGB channels (pure string maths, deterministic); non-hex inputs pass through unchanged. */
export function darkenHex(hex: string, factor: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return formatHex([rgb[0] * factor, rgb[1] * factor, rgb[2] * factor]);
}

/** Lerp a hex colour toward white by `t` (the neon core brighten); non-hex inputs pass through unchanged. */
export function lightenHex(hex: string, t: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return formatHex([
    rgb[0] + (255 - rgb[0]) * t,
    rgb[1] + (255 - rgb[1]) * t,
    rgb[2] + (255 - rgb[2]) * t,
  ]);
}

/** gradient's two stops: colorA (else accent) and colorB (else a darkened colorA). */
export function gradientStops(look: ResolvedTextLook, accent: string): { a: string; b: string } {
  const a = look.colorA ?? accent;
  return { a, b: look.colorB ?? darkenHex(a, GRADIENT_B_DARKEN) };
}

/** The gradient projection over the measured block: t = (sHi − dot(p, axis)) × invRange runs 0 at the axis head (colorA) to 1 at the tail (colorB), so 90° puts colorA on top. Null until bounds measure or when the block is degenerate (the shader's invRange-0 guard keeps the plain fill). */
export interface GradientSpan {
  ax: number;
  ay: number;
  sHi: number;
  invRange: number;
}

export function gradientSpan(
  bounds: readonly [number, number, number, number] | null,
  angleDeg: number,
): GradientSpan | null {
  if (!bounds) return null;
  const rad = (angleDeg * Math.PI) / 180;
  const ax = Math.cos(rad);
  const ay = Math.sin(rad);
  const [minX, minY, maxX, maxY] = bounds;
  const s1 = minX * ax + minY * ay;
  const s2 = maxX * ax + minY * ay;
  const s3 = minX * ax + maxY * ay;
  const s4 = maxX * ax + maxY * ay;
  const sMin = Math.min(s1, s2, s3, s4);
  const sMax = Math.max(s1, s2, s3, s4);
  if (sMax - sMin <= 0) return null;
  return { ax, ay, sHi: sMax, invRange: 1 / (sMax - sMin) };
}

/** arc's bend spec: radius from the measured width and total curve (R = width / curveRad), signed so positive curveDeg arcs upward (smile). Null (the exact identity) until measured or at zero curve. */
export interface ArcSpec {
  invRadius: number;
  centerX: number;
}

export function arcSpec(
  bounds: readonly [number, number, number, number] | null,
  curveDeg: number,
): ArcSpec | null {
  if (!bounds || curveDeg === 0) return null;
  const width = bounds[2] - bounds[0];
  if (width <= 0) return null;
  return { invRadius: (curveDeg * Math.PI) / 180 / width, centerX: (bounds[0] + bounds[2]) / 2 };
}

/** CPU twin of the shader's arc term for one rest centre X (what EmojiQuads mirror): the rigid roll about the glyph centre plus the arc displacement, with θ = s / R along the baseline. */
export function arcGlyphTransform(
  restCenterX: number,
  spec: ArcSpec,
): { dx: number; dy: number; rotRad: number } {
  const s = restCenterX - spec.centerX;
  const theta = s * spec.invRadius;
  const r = 1 / spec.invRadius;
  return { dx: r * Math.sin(theta) - s, dy: r * (1 - Math.cos(theta)), rotRad: theta };
}

/** outline's troika stroke props (main-pass uniforms, so they ride every render path). */
export function outlineStroke(
  look: ResolvedTextLook,
  accent: string,
  fontSize: number,
): { strokeWidth: number; strokeColor: string } {
  return { strokeWidth: look.strokeEm * fontSize, strokeColor: lookColorA(look, accent) };
}

/** neon's persistent halo (troika's outline pass) plus the brightened core fill, scaled by intensity. */
export function neonHalo(
  look: ResolvedTextLook,
  accent: string,
  fontSize: number,
): { outlineBlur: number; outlineColor: string; outlineOpacity: number } {
  return {
    outlineBlur: NEON_BLUR_EM * look.intensity * fontSize,
    outlineColor: lookColorA(look, accent),
    outlineOpacity: NEON_HALO_OPACITY * look.intensity,
  };
}

export function neonCoreFill(fill: string, intensity: number): string {
  return lightenHex(fill, NEON_CORE_LIFT * intensity);
}

/** frosted's per-unit pack deltas (added to every sample's softEm/weightEm before upload); exactly zero at intensity 0, so the uploaded floats match the look-off bytes. */
export function frostedDeltas(intensity: number): { softEm: number; weightEm: number } {
  return { softEm: FROSTED_SOFT_EM * intensity, weightEm: FROSTED_WEIGHT_EM * intensity };
}
