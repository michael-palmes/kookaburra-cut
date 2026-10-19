import type { EmphasisRange } from "./displayText";

/** Per-word emphasis styling: `*word*` ranges (displayText.ts) take a colour and an SDF weight, from the sidecar's `textStyle.<key>Emphasis` ("<colour>" or "<colour>@<weight>"). Pure; the stagger material draws it. */

// ── Contract constants (changing any re-renders every emphasised word) ──
/** Weight gain when no `@weight` is given, em (roughly a regular-to-bold step). */
export const EMPHASIS_WEIGHT_EM = 0.03;
/** SDF em per CSS weight unit relative to the face's own weight (300 units = the default gain). */
export const EMPHASIS_EM_PER_WEIGHT = 0.0001;
/** Weight shift clamp either way, em. */
export const EMPHASIS_WEIGHT_MAX_EM = 0.08;
/** Per-line emphasis rects a text carries; extra ranges render plain. */
export const MAX_EMPHASIS_RECTS = 16;

const EMPHASIS_VALUE = /^(text|muted|accent|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})(?:@(\d{1,4}))?$/;

export interface EmphasisValue {
  /** A colour token (`text`, `muted`, `accent`) or a hex. */
  colour: string;
  /** CSS weight 1..1000; absent takes the default gain. */
  weight?: number;
}

/** Parse a `<key>Emphasis` value; null when it is not "<colour>" or "<colour>@<weight>". */
export function parseEmphasisValue(value: unknown): EmphasisValue | null {
  if (typeof value !== "string") return null;
  const m = EMPHASIS_VALUE.exec(value.trim());
  if (!m) return null;
  if (m[2] === undefined) return { colour: m[1] };
  const weight = Number(m[2]);
  return weight >= 1 && weight <= 1000 ? { colour: m[1], weight } : null;
}

export interface ResolvedEmphasis {
  /** sRGB hex (tokens resolved). */
  color: string;
  /** SDF weight shift in em (+ bolder). */
  weightEm: number;
}

/** The emphasis an unset or invalid value falls back to: the theme accent, one weight step bolder. */
export function resolveEmphasis(
  colors: { text: string; muted: string; accent: string },
  value: unknown,
  faceWeight: number,
): ResolvedEmphasis {
  const parsed = parseEmphasisValue(value);
  const colour = parsed?.colour ?? "accent";
  const color =
    colour === "text" || colour === "muted" || colour === "accent" ? colors[colour] : colour;
  if (parsed?.weight === undefined) return { color, weightEm: EMPHASIS_WEIGHT_EM };
  const em = (parsed.weight - faceWeight) * EMPHASIS_EM_PER_WEIGHT;
  return {
    color,
    weightEm: Math.min(EMPHASIS_WEIGHT_MAX_EM, Math.max(-EMPHASIS_WEIGHT_MAX_EM, em)),
  };
}

let warnedRects = false;

/** Per-line rects ([minX, minY, maxX, maxY] each, layout space) covering every emphasised range's glyphs, from troika's carets (`[startX, endX, bottomY, topY]` per char); whitespace joins no rect and a range that wraps gets one rect per line. Capped at MAX_EMPHASIS_RECTS. */
export function computeEmphasisRects(
  text: string,
  ranges: readonly EmphasisRange[],
  carets: Float32Array,
): Float32Array {
  const rects: number[] = [];
  const charCount = Math.min(text.length, Math.floor(carets.length / 4));
  for (const [start, end] of ranges) {
    let line: number[] | null = null;
    for (let i = start; i < Math.min(end, charCount); i++) {
      if (/\s/.test(text[i])) continue;
      const o = i * 4;
      const x0 = Math.min(carets[o], carets[o + 1]);
      const x1 = Math.max(carets[o], carets[o + 1]);
      const y0 = Math.min(carets[o + 2], carets[o + 3]);
      const y1 = Math.max(carets[o + 2], carets[o + 3]);
      if (line && Math.abs(line[1] - y0) < 1e-6 && Math.abs(line[3] - y1) < 1e-6) {
        line[0] = Math.min(line[0], x0);
        line[2] = Math.max(line[2], x1);
        continue;
      }
      if (line) rects.push(...line);
      line = [x0, y0, x1, y1];
    }
    if (line) rects.push(...line);
  }
  if (rects.length / 4 > MAX_EMPHASIS_RECTS && !warnedRects) {
    warnedRects = true;
    console.warn(
      `[text] more than ${MAX_EMPHASIS_RECTS} emphasised line spans; extras render plain`,
    );
  }
  return new Float32Array(rects.slice(0, MAX_EMPHASIS_RECTS * 4));
}
