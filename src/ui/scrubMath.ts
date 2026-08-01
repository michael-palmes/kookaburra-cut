/** Pure px↔ms mapping for the timeline dock, shared by the playback bar and the animation lane; structure-pinned in unit tests so scrub geometry can't drift between them. */

import { attributionBoundaries } from "../engine/sceneTimeline";

/** The scrub step (ms); parity with the old range input's `step={16}`. */
export const SCRUB_STEP_MS = 16;

/** Smallest share of the track a scene cell may DISPLAY, so a very short scene stays readable and clickable. */
export const SCENE_CELL_FLOOR = 0.08;

/** Track x → clock ms: clamped, proportional, snapped to `stepMs` (old range-input semantics), never past either end. Pass `spans` to map per cell instead, so a cell widened by the display floor scrubs across its own attribution window; omit them and this is the plain linear mapping. */
export function msFromTrackX(
  x: number,
  width: number,
  durationMs: number,
  spans?: readonly SceneCellSpan[],
  stepMs: number = SCRUB_STEP_MS,
): number {
  if (width <= 0 || durationMs <= 0) return 0;
  const t = Math.min(1, Math.max(0, x / width));
  // The far end always lands exactly on the duration (a range input's max is always reachable); snapping there would fall one part-step short.
  if (t >= 1) return durationMs;
  const ms = cellMsAt(spans, t) ?? t * durationMs;
  const snapped = Math.round(ms / stepMs) * stepMs;
  return Math.min(durationMs, Math.max(0, snapped));
}

/** Clock ms → playhead fraction (0..1), for `left: {fraction * 100}%`; with `spans` it inverts the per-cell mapping, so the playhead always sits inside the cell `activeSceneIndex` calls active. */
export function playheadFraction(
  currentMs: number,
  durationMs: number,
  spans?: readonly SceneCellSpan[],
): number {
  if (durationMs <= 0) return 0;
  const clamped = Math.min(durationMs, Math.max(0, currentMs));
  return cellFractionAt(spans, clamped) ?? Math.min(1, Math.max(0, currentMs / durationMs));
}

export interface SceneCellSpan {
  index: number;
  /** Flex weight: the cell's DISPLAY size, ms-scaled (the exact attribution ms whenever nothing is below the floor). */
  weight: number;
  /** True attribution window start (ms), the boundary `activeSceneIndex` reads. */
  startMs: number;
  /** True attribution window end (ms): the next cell's start, or the project total on the last cell. */
  endMs: number;
}

/** Scene cells tile the track exactly on ATTRIBUTION boundaries (mid-transition to mid-transition, project ends excepted), matching `activeSceneIndex`, so the drawn scene change sits halfway through each transition and the bold name always agrees with its cell; the display weights then take the floor pass, while startMs/endMs stay the true boundaries the scrub maps against. */
export function sceneCellSpans(
  slots: { startMs: number; durationMs: number; transitionIn?: { durationMs: number } }[],
  totalMs: number,
): SceneCellSpan[] {
  const starts = attributionBoundaries(slots);
  return balanceCellWeights(
    slots.map((_slot, i) => {
      const startMs = starts[i];
      const endMs = i + 1 < slots.length ? starts[i + 1] : totalMs;
      return { index: i, weight: Math.max(1, endMs - startMs), startMs, endMs };
    }),
  );
}

/** The floor waterfill: cells under `SCENE_CELL_FLOOR` pin to it and the rest rescale into what is left, walked shortest first so one pass suffices (a pin only ever lowers the scale, so nothing already cleared can drop back). Exact proportions survive untouched when every cell clears the floor, and the floor gives way to equal widths when it cannot fit (n * FLOOR >= 1). */
function balanceCellWeights(spans: SceneCellSpan[]): SceneCellSpan[] {
  const total = weightTotal(spans);
  if (spans.length === 0 || total <= 0) return spans;
  if (spans.length * SCENE_CELL_FLOOR >= 1)
    return spans.map((s) => ({ ...s, weight: total / spans.length }));
  if (spans.every((s) => s.weight >= SCENE_CELL_FLOOR * total)) return spans;

  const order = spans.map((_s, i) => i).sort((a, b) => spans[a].weight - spans[b].weight);
  const pinned = new Set<number>();
  let freeShare = 1;
  for (const i of order) {
    const scale = freeShare > 0 ? (1 - pinned.size * SCENE_CELL_FLOOR) / freeShare : 0;
    if ((spans[i].weight / total) * scale >= SCENE_CELL_FLOOR) break;
    pinned.add(i);
    freeShare -= spans[i].weight / total;
  }
  const scale = freeShare > 0 ? (1 - pinned.size * SCENE_CELL_FLOOR) / freeShare : 0;
  return spans.map((s, i) => ({
    ...s,
    weight: pinned.has(i) ? SCENE_CELL_FLOOR * total : s.weight * scale,
  }));
}

const weightTotal = (spans: readonly SceneCellSpan[]): number =>
  spans.reduce((sum, s) => sum + s.weight, 0);

/** Display fraction → ms: the cell owning `t`, mapped linearly across its attribution window; null when the spans can't drive a mapping, so the caller falls back to the linear one. */
function cellMsAt(spans: readonly SceneCellSpan[] | undefined, t: number): number | null {
  if (!spans?.length) return null;
  const total = weightTotal(spans);
  if (total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < spans.length; i++) {
    const share = spans[i].weight / total;
    if (t < acc + share || i === spans.length - 1) {
      const local = share > 0 ? Math.min(1, Math.max(0, (t - acc) / share)) : 0;
      return spans[i].startMs + local * Math.max(0, spans[i].endMs - spans[i].startMs);
    }
    acc += share;
  }
  return null;
}

/** ms → display fraction: resolves the cell exactly as `activeSceneIndex` does (the last cell whose attribution window contains ms), so the playhead and the bold cell can never disagree. */
function cellFractionAt(spans: readonly SceneCellSpan[] | undefined, ms: number): number | null {
  if (!spans?.length) return null;
  const total = weightTotal(spans);
  if (total <= 0) return null;
  let found = -1;
  let cellStart = 0;
  let acc = 0;
  for (let i = 0; i < spans.length; i++) {
    if (ms >= spans[i].startMs && ms < spans[i].endMs) {
      found = i;
      cellStart = acc;
    }
    acc += spans[i].weight / total;
  }
  if (found < 0) return ms <= spans[0].startMs ? 0 : 1;
  const span = spans[found];
  const width = span.endMs - span.startMs;
  const local = width > 0 ? Math.min(1, Math.max(0, (ms - span.startMs) / width)) : 0;
  return Math.min(1, Math.max(0, cellStart + local * (span.weight / total)));
}
