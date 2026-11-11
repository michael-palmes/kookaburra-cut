import type { StaggerUnits, TextUnitSample } from "./presets";

/** `render.textBlur: "optical"`: a preset's per-unit soften becomes a true gaussian defocus. Every constant here is export contract once a project opts in. */

/** σ per unit of SDF soften: the gaussian whose edge slope matches troika's ±soft smoothstep band at its centre (0.75/r = 1/(σ√2π)). */
export const OPTICAL_SIGMA_PER_SOFT = 0.53;
/** Below this soften (em) a unit renders crisp: under a third of a pixel of σ at any headline size. */
export const OPTICAL_SOFT_EPS_EM = 0.006;
/** Units blur in at most this many σ levels a frame (one capture and blur each). */
export const OPTICAL_MAX_LEVELS = 4;
/** Units whose σ sits within this ratio share a level. */
export const OPTICAL_LEVEL_RATIO = 1.15;
/** Capture padding past the moved ink, in σ: the kernel reaches 3σ, the rest keeps its edge texels empty. */
export const OPTICAL_PAD_SIGMAS = 3.5;
/** Ink overhang past a unit's caret extents and line box, em. */
export const OPTICAL_MARGIN_EM = 0.25;
/** A glyph rolling about its own centre stays inside this reach, em. */
export const OPTICAL_ROLL_REACH_EM = 0.5;
/** The capture resolves σ in at most this many texels (it drops resolution instead of adding taps). */
export const OPTICAL_MAX_SIGMA_TEXELS = 6;
/** Capture texels per screen pixel when σ is small, so the handoff to crisp text never softens. */
export const OPTICAL_MAX_SUPERSAMPLE = 1.5;
/** Largest capture edge, texels. */
export const OPTICAL_MAX_TARGET = 4096;
/** The blur shader's tap loop bound (radius ceil(3σ) at the quantised σ ceiling fits). */
export const OPTICAL_MAX_RADIUS = 32;

/** Layout-space rect: [left, bottom, right, top]. */
export type Rect = readonly [number, number, number, number];

export interface OpticalBlurLevel {
  /** Gaussian σ, layout units. */
  sigma: number;
  units: readonly number[];
  /** The padded capture rect, layout units. */
  rect: Rect;
}

export interface OpticalBlurPlan {
  levels: readonly OpticalBlurLevel[];
  /** The main pass: blurred units hidden, near-zero soften snapped crisp. */
  main: TextUnitSample[];
  /** One capture per level: only its units visible, their soften zeroed (the gaussian replaces it). */
  captures: TextUnitSample[][];
}

/** Units the optical path can take: a visible, planar unit with a real soften (depth, tips and turns keep the SDF soften, since the capture is flat). */
export function opticalEligible(s: TextUnitSample): boolean {
  return (
    s.alpha > 0 &&
    s.softEm >= OPTICAL_SOFT_EPS_EM &&
    s.dzEm === 0 &&
    s.rotXRad === 0 &&
    s.rotYRad === 0
  );
}

/** Each unit's rest rect from its caret extents and line box (the block's when unmeasured), widened by the ink margin. */
export function unitRestRects(
  units: StaggerUnits | null,
  unitBoxes: Float32Array | null,
  bounds: Rect | null,
  fontSize: number,
): Rect[] | null {
  if (!units || !bounds) return null;
  const m = OPTICAL_MARGIN_EM * fontSize;
  const rects: Rect[] = [];
  for (let i = 0; i < units.count; i++) {
    const hasBox = unitBoxes !== null && i * 2 + 1 < unitBoxes.length;
    const y0 = hasBox ? Math.min(unitBoxes[i * 2], bounds[1]) : bounds[1];
    const y1 = hasBox ? Math.max(unitBoxes[i * 2 + 1], bounds[3]) : bounds[3];
    rects.push([units.startX[i] - m, y0 - m, units.endX[i] + m, y1 + m]);
  }
  return rects;
}

/** Where a unit's ink can reach this frame: its rest rect through the pack's planar terms (roll, offset, weight and chroma echo, then the unit-centre scale). */
export function movedRect(
  rest: Rect,
  centre: readonly [number, number],
  s: TextUnitSample,
  fontSize: number,
): Rect {
  const grow =
    (s.rotZRad !== 0 ? OPTICAL_ROLL_REACH_EM * fontSize : 0) +
    (Math.max(0, s.weightEm) + Math.abs(s.chromaEm)) * fontSize;
  const dx = s.dxEm * fontSize;
  const dy = s.dyEm * fontSize;
  const sx = Math.abs(s.scale * s.scaleX);
  const sy = Math.abs(s.scale * s.scaleY);
  const x0 = centre[0] + (rest[0] - grow + dx - centre[0]) * sx;
  const x1 = centre[0] + (rest[2] + grow + dx - centre[0]) * sx;
  const y0 = centre[1] + (rest[1] - grow + dy - centre[1]) * sy;
  const y1 = centre[1] + (rest[3] + grow + dy - centre[1]) * sy;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** Groups σ values (sorted ascending) into runs within the level ratio, then merges the closest neighbours down to the level cap. */
export function groupSigmas(sorted: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length; i++) {
    const last = runs[runs.length - 1];
    if (last && sorted[i] <= sorted[last[0]] * OPTICAL_LEVEL_RATIO) last[1] = i;
    else runs.push([i, i]);
  }
  while (runs.length > OPTICAL_MAX_LEVELS) {
    let best = 0;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let k = 0; k + 1 < runs.length; k++) {
      const ratio = sorted[runs[k + 1][1]] / sorted[runs[k][0]];
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = k;
      }
    }
    runs.splice(best, 2, [runs[best][0], runs[best + 1][1]]);
  }
  return runs;
}

/** Splits this frame's units between the crisp main pass and up to four blurred σ levels; null until the units are measured (the frame then keeps its SDF soften). */
export function planOpticalBlur(
  samples: readonly TextUnitSample[],
  units: StaggerUnits | null,
  rests: readonly Rect[] | null,
  fontSize: number,
  /** Extra reach for layers drawn offset from the main text (offset-print), layout units. */
  layerReach = 0,
): OpticalBlurPlan | null {
  if (!units || !rests) return null;
  const n = Math.min(samples.length, units.count, rests.length);
  const picked: Array<{ unit: number; sigma: number }> = [];
  for (let i = 0; i < n; i++) {
    if (opticalEligible(samples[i])) {
      picked.push({ unit: i, sigma: samples[i].softEm * fontSize * OPTICAL_SIGMA_PER_SOFT });
    }
  }
  const main = samples.map((s) =>
    s.softEm > 0 && s.softEm < OPTICAL_SOFT_EPS_EM ? { ...s, softEm: 0 } : { ...s },
  );
  if (picked.length === 0) return { levels: [], main, captures: [] };
  picked.sort((a, b) => a.sigma - b.sigma || a.unit - b.unit);
  const runs = groupSigmas(picked.map((p) => p.sigma));
  const levels: OpticalBlurLevel[] = [];
  const captures: TextUnitSample[][] = [];
  for (const [from, to] of runs) {
    const members = picked.slice(from, to + 1).map((p) => p.unit);
    const sigma = Math.sqrt(picked[from].sigma * picked[to].sigma);
    const pad = OPTICAL_PAD_SIGMAS * sigma + layerReach;
    let rect: [number, number, number, number] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const u of members) {
      const centre: [number, number] = [(units.startX[u] + units.endX[u]) / 2, units.centerY[u]];
      const r = movedRect(rests[u], centre, samples[u], fontSize);
      rect = [
        Math.min(rect[0], r[0]),
        Math.min(rect[1], r[1]),
        Math.max(rect[2], r[2]),
        Math.max(rect[3], r[3]),
      ];
    }
    levels.push({
      sigma,
      units: members,
      rect: [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad],
    });
    const inLevel = new Set(members);
    captures.push(
      samples.map((s, i) => (inLevel.has(i) ? { ...s, softEm: 0 } : { ...s, alpha: 0 })),
    );
    for (const u of members) main[u].alpha = 0;
  }
  return { levels, main, captures };
}

/** Screen pixels per layout unit at a point `depth` in front of the camera (perspective) or anywhere (orthographic). */
export function screenDensity(
  projY: number,
  perspective: boolean,
  depth: number,
  worldScale: number,
  heightPx: number,
): number {
  const d = perspective ? Math.max(depth, 1e-3) : 1;
  return (heightPx / 2) * projY * (worldScale / d);
}

/** Capture texels per layout unit for a level: screen density, supersampled while σ is small and dropped while it is large (σ never spans more than a few texels), quantised to quarter octaves so a slow camera move reuses one size, and capped to the target limit. */
export function captureDensity(sigma: number, density: number, rect: Rect): number {
  const sigmaPx = sigma * density;
  const s = Math.min(OPTICAL_MAX_SUPERSAMPLE, OPTICAL_MAX_SIGMA_TEXELS / Math.max(sigmaPx, 1e-6));
  const raw = Math.max(1e-6, density * s);
  const quantised = 2 ** (Math.ceil(Math.log2(raw) * 4) / 4);
  const span = Math.max(rect[2] - rect[0], rect[3] - rect[1], 1e-6);
  return Math.min(quantised, OPTICAL_MAX_TARGET / span);
}

/** Target texels for a rect at a density, at least one each way. */
export function captureSize(rect: Rect, density: number): [number, number] {
  return [
    Math.max(1, Math.min(OPTICAL_MAX_TARGET, Math.ceil((rect[2] - rect[0]) * density))),
    Math.max(1, Math.min(OPTICAL_MAX_TARGET, Math.ceil((rect[3] - rect[1]) * density))),
  ];
}

/** Allocation bucket for a capture edge, so sizes that drift frame to frame reuse one target. */
export function bucketSize(n: number): number {
  return Math.ceil(n / 64) * 64;
}

/** Tap radius for σ in texels (3σ), within the shader's loop bound. */
export function tapRadius(sigmaTexels: number): number {
  return Math.min(OPTICAL_MAX_RADIUS, Math.ceil(3 * Math.max(0, sigmaTexels)));
}

/** The normalised one-sided gaussian the blur pass evaluates (index 0 is the centre tap); the full kernel sums to 1. */
export function gaussianWeights(sigmaTexels: number): number[] {
  const r = tapRadius(sigmaTexels);
  if (r === 0) return [1];
  const inv = -0.5 / (sigmaTexels * sigmaTexels);
  const w: number[] = [];
  let total = 0;
  for (let i = 0; i <= r; i++) {
    const v = Math.exp(i * i * inv);
    w.push(v);
    total += i === 0 ? v : 2 * v;
  }
  return w.map((v) => v / total);
}
