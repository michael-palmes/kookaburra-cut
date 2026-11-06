import { ease } from "../../engine/ease";
import type { EmphasisRange, PreparedDisplayText } from "./displayText";

/** Per-word emphasis styling: `*word*` ranges (displayText.ts) take a colour and an SDF weight, from the sidecar's `textStyle.<key>Emphasis` ("<colour>", "<colour>@<weight>", either followed by a shape: "accent pill"). A shape wraps each range in a pill that draws on, then fills while its words turn the background colour. Pure; the stagger material draws the words and `EmphasisPills` the shapes. */

// ── Contract constants (changing any re-renders every emphasised word) ──
/** Weight gain when no `@weight` is given, em (roughly a regular-to-bold step). */
export const EMPHASIS_WEIGHT_EM = 0.03;
/** SDF em per CSS weight unit relative to the face's own weight (300 units = the default gain). */
export const EMPHASIS_EM_PER_WEIGHT = 0.0001;
/** Weight shift clamp either way, em. */
export const EMPHASIS_WEIGHT_MAX_EM = 0.08;
/** Per-line emphasis rects a text carries; extra ranges render plain. */
export const MAX_EMPHASIS_RECTS = 16;

/** Shapes an emphasis can wrap its words in: a capsule, or a battery (a rounded body with a terminal). */
export type EmphasisShape = "pill" | "battery";

export const EMPHASIS_SHAPES: readonly EmphasisShape[] = ["pill", "battery"];

const EMPHASIS_VALUE =
  /^(text|muted|accent|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})(?:@(\d{1,4}))?(?:\s+(pill|battery))?$/;

export interface EmphasisValue {
  /** A colour token (`text`, `muted`, `accent`) or a hex. */
  colour: string;
  /** CSS weight 1..1000; absent takes the default gain. */
  weight?: number;
  /** Wrap each emphasised range in this shape. */
  shape?: EmphasisShape;
}

/** Parse a `<key>Emphasis` value; null when it is not "<colour>" or "<colour>@<weight>", either optionally followed by a shape. */
export function parseEmphasisValue(value: unknown): EmphasisValue | null {
  if (typeof value !== "string") return null;
  const m = EMPHASIS_VALUE.exec(value.trim());
  if (!m) return null;
  const shape = m[3] === undefined ? {} : { shape: m[3] as EmphasisShape };
  if (m[2] === undefined) return { colour: m[1], ...shape };
  const weight = Number(m[2]);
  return weight >= 1 && weight <= 1000 ? { colour: m[1], weight, ...shape } : null;
}

export interface ResolvedEmphasis {
  /** sRGB hex (tokens resolved). */
  color: string;
  /** SDF weight shift in em (+ bolder). */
  weightEm: number;
  /** Present only for a shaped emphasis. */
  shape?: EmphasisShape;
  /** The words' colour once the shape fills: the theme background. Present with `shape`. */
  filledColor?: string;
}

/** The emphasis an unset or invalid value falls back to: the theme accent, one weight step bolder. */
export function resolveEmphasis(
  colors: { text: string; muted: string; accent: string; background?: string },
  value: unknown,
  faceWeight: number,
): ResolvedEmphasis {
  const parsed = parseEmphasisValue(value);
  const colour = parsed?.colour ?? "accent";
  const color =
    colour === "text" || colour === "muted" || colour === "accent" ? colors[colour] : colour;
  const shaped = parsed?.shape
    ? { shape: parsed.shape, filledColor: colors.background ?? "#000000" }
    : {};
  if (parsed?.weight === undefined) return { color, weightEm: EMPHASIS_WEIGHT_EM, ...shaped };
  const em = (parsed.weight - faceWeight) * EMPHASIS_EM_PER_WEIGHT;
  return {
    color,
    weightEm: Math.min(EMPHASIS_WEIGHT_MAX_EM, Math.max(-EMPHASIS_WEIGHT_MAX_EM, em)),
    ...shaped,
  };
}

// ── Shaped emphasis (contract constants: changing any moves every pill) ──
/** Room the pill leaves round its words, em. */
export const PILL_PAD_X_EM = 0.26;
export const PILL_PAD_Y_EM = 0;
/** Outline width, em. */
export const PILL_STROKE_EM = 0.055;
/** The battery body's corner radius as a fraction of its height. */
export const BATTERY_RADIUS = 0.3;
/** The battery's terminal: width and gap in em, height as a fraction of the body's. */
export const BATTERY_NUB_W_EM = 0.11;
export const BATTERY_NUB_GAP_EM = 0.05;
export const BATTERY_NUB_H = 0.4;
/** The outline traces on over this, then the fill floods in, overlapping its tail. */
export const PILL_DRAW_MS = 560;
export const PILL_FILL_DELAY_MS = 420;
export const PILL_FILL_MS = 320;

/** One shaped emphasis in layout units: the body rect by centre and half size, its corner radius, the outline width and a battery's terminal. */
export interface EmphasisPill {
  /** The emphasis rect it wraps (rects are 4 floats each). */
  rect: number;
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
  radius: number;
  stroke: number;
  nub: { cx: number; cy: number; halfW: number; halfH: number; radius: number } | null;
}

/** The pills for one text, one per emphasis rect (`computeEmphasisRects`), padded round the words; a battery adds its terminal on the right. */
export function emphasisPills(
  rects: Float32Array,
  fontSize: number,
  shape: EmphasisShape,
): EmphasisPill[] {
  const pills: EmphasisPill[] = [];
  const padX = PILL_PAD_X_EM * fontSize;
  const padY = PILL_PAD_Y_EM * fontSize;
  for (let i = 0; i + 3 < rects.length; i += 4) {
    const [x0, y0, x1, y1] = [rects[i], rects[i + 1], rects[i + 2], rects[i + 3]];
    if (!(x1 > x0 && y1 > y0)) continue;
    const halfW = (x1 - x0) / 2 + padX;
    const halfH = (y1 - y0) / 2 + padY;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const battery = shape === "battery";
    const nubHalfW = (BATTERY_NUB_W_EM * fontSize) / 2;
    const nubHalfH = BATTERY_NUB_H * halfH;
    pills.push({
      rect: i / 4,
      cx,
      cy,
      halfW,
      halfH,
      radius: battery ? Math.min(halfH, BATTERY_RADIUS * 2 * halfH) : halfH,
      stroke: PILL_STROKE_EM * fontSize,
      nub: battery
        ? {
            cx: cx + halfW + BATTERY_NUB_GAP_EM * fontSize + nubHalfW,
            cy,
            halfW: nubHalfW,
            halfH: nubHalfH,
            radius: Math.min(nubHalfW, nubHalfH) * 0.6,
          }
        : null,
    });
  }
  return pills;
}

/** How far a pill has drawn on and filled at `localMs` when it starts at `startMs`, each 0..1. */
export function emphasisPillPhase(
  localMs: number,
  startMs: number,
): { draw: number; fill: number } {
  const t = localMs - startMs;
  return {
    draw: ease("inOutCubic", t / PILL_DRAW_MS),
    fill: ease("outCubic", (t - PILL_FILL_DELAY_MS) / PILL_FILL_MS),
  };
}

/** A shaped emphasis needs room inside the line: one space either side of every range, two after a battery for its terminal (none at a line's start or end), with the ranges and emoji clusters moved to match. Only shaped emphasis calls it, so plain text keeps its exact layout. */
export function padEmphasisRanges(
  prepared: PreparedDisplayText,
  shape: EmphasisShape = "pill",
): PreparedDisplayText {
  if (prepared.emphasis.length === 0) return prepared;
  const { text } = prepared;
  const inserts: number[] = [];
  const after = shape === "battery" ? 2 : 1;
  for (const [start, end] of prepared.emphasis) {
    if (start > 0 && text[start - 1] !== "\n") inserts.push(start);
    if (end < text.length && text[end] !== "\n") for (let k = 0; k < after; k++) inserts.push(end);
  }
  if (inserts.length === 0) return prepared;
  const shift = (index: number, after: boolean) => {
    let n = 0;
    for (const at of inserts) if (at < index || (after && at === index)) n++;
    return index + n;
  };
  let out = "";
  let from = 0;
  for (const at of inserts) {
    out += `${text.slice(from, at)} `;
    from = at;
  }
  out += text.slice(from);
  return {
    text: out,
    clusters: prepared.clusters.map((c) => ({ ...c, codeUnitIndex: shift(c.codeUnitIndex, true) })),
    emphasis: prepared.emphasis.map(([s, e]) => [shift(s, true), shift(e, false)] as const),
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
