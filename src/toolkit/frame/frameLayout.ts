/** Pure layout math for the overlay cutout, golden-tested (the `fixedMath.ts` pinning pattern): these formulas size the scene render target and drive the cutout SDF, so every constant below is EXPORT CONTRACT. No clock reads, no randomness, no history: a pure function of (aspect, spec). See docs/overlays.md. */

import type { FrameCutoutSpec, FrameShape, FrameSide } from "./types";

/** Fraction of the split axis the cutout column occupies by default. */
export const DEFAULT_CUTOUT_SIZE = 0.56;
/** Margin between cutout and frame edge, as a fraction of the shorter frame edge. */
export const DEFAULT_CUTOUT_INSET = 0.04;
/** Corner radius as a fraction of half the cutout's shorter edge. */
export const DEFAULT_CUTOUT_RADIUS = 0.12;
/** Superellipse exponent for `squircle`; 2 is an ellipse, 4 the continuous-curve squircle. */
export const SQUIRCLE_EXPONENT = 4;

const MIN_SIZE = 0.1;
const MAX_SIZE = 1;
const MAX_INSET = 0.2;
/** Keeps a degenerate spec from producing a zero-area render target. */
const MIN_EXTENT = 1e-3;

/** Normalised frame rectangle: origin top-left, x right, y down, both axes 0..1. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameLayout {
  /** Wide frames split left/right, tall and square frames split top/bottom. */
  axis: "horizontal" | "vertical";
  /** Where the scene renders. */
  cutout: FrameRect;
  /** What is left for the text column, inset by the same margins. */
  content: FrameRect;
  /** SDF corner radius in PHYSICAL units, where the frame height is 1. */
  radius: number;
  /** Superellipse exponent, meaningful for `squircle` only. */
  exponent: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Wide frames split along x; 1:1 and taller split along y, so a portrait text column never gets squeezed. */
export function frameAxis(aspect: number): "horizontal" | "vertical" {
  return aspect > 1 ? "horizontal" : "vertical";
}

/** Per-axis normalised margins for an inset expressed against the shorter PHYSICAL edge, so the gap looks equal on all four sides at any aspect. */
function margins(aspect: number, inset: number): { x: number; y: number } {
  const physical = inset * Math.min(aspect, 1);
  return { x: physical / aspect, y: physical };
}

/** Shrinks a rect to a centred physical square, so `circle` stays circular at any aspect. */
function squared(rect: FrameRect, aspect: number): FrameRect {
  const diameter = Math.min(rect.width * aspect, rect.height);
  const width = diameter / aspect;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - diameter) / 2,
    width,
    height: diameter,
  };
}

/** Corner radius in physical units. `circle`/`capsule` are fully rounded, `rect` is sharp, `squircle` carries its curve in the exponent instead. */
function resolveRadius(shape: FrameShape, rect: FrameRect, aspect: number, radius: number): number {
  const shorterHalf = Math.min((rect.width * aspect) / 2, rect.height / 2);
  switch (shape) {
    case "rect":
    case "squircle":
      return 0;
    case "circle":
    case "capsule":
      return shorterHalf;
    default:
      return clamp(radius, 0, 1) * shorterHalf;
  }
}

export function frameLayout(aspect: number, spec: FrameCutoutSpec): FrameLayout {
  const axis = frameAxis(aspect);
  const size = clamp(spec.size ?? DEFAULT_CUTOUT_SIZE, MIN_SIZE, MAX_SIZE);
  const inset = clamp(spec.inset ?? DEFAULT_CUTOUT_INSET, 0, MAX_INSET);
  const side: FrameSide = spec.side ?? "start";
  const m = margins(aspect, inset);

  let cutout: FrameRect;
  let content: FrameRect;
  if (axis === "horizontal") {
    const start = side === "start" ? 0 : 1 - size;
    cutout = {
      x: start + m.x,
      y: m.y,
      width: Math.max(MIN_EXTENT, size - 2 * m.x),
      height: Math.max(MIN_EXTENT, 1 - 2 * m.y),
    };
    const contentStart = side === "start" ? size : 0;
    content = {
      x: contentStart + m.x,
      y: m.y,
      width: Math.max(MIN_EXTENT, 1 - size - 2 * m.x),
      height: Math.max(MIN_EXTENT, 1 - 2 * m.y),
    };
  } else {
    const start = side === "start" ? 0 : 1 - size;
    cutout = {
      x: m.x,
      y: start + m.y,
      width: Math.max(MIN_EXTENT, 1 - 2 * m.x),
      height: Math.max(MIN_EXTENT, size - 2 * m.y),
    };
    const contentStart = side === "start" ? size : 0;
    content = {
      x: m.x,
      y: contentStart + m.y,
      width: Math.max(MIN_EXTENT, 1 - 2 * m.x),
      height: Math.max(MIN_EXTENT, 1 - size - 2 * m.y),
    };
  }

  if (spec.shape === "circle") cutout = squared(cutout, aspect);

  return {
    axis,
    cutout,
    content,
    radius: resolveRadius(spec.shape, cutout, aspect, spec.radius ?? DEFAULT_CUTOUT_RADIUS),
    exponent: SQUIRCLE_EXPONENT,
  };
}

/** Integer pixel rect for the scene render target. Rounded (never floored) so the target keeps the cutout's aspect as closely as the grid allows, and clamped to 1px so a degenerate spec cannot allocate a zero-area target. */
export function cutoutPixelRect(
  rect: FrameRect,
  frameWidth: number,
  frameHeight: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(rect.x * frameWidth),
    y: Math.round(rect.y * frameHeight),
    width: Math.max(1, Math.round(rect.width * frameWidth)),
    height: Math.max(1, Math.round(rect.height * frameHeight)),
  };
}
