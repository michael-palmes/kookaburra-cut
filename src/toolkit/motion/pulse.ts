import { envelopeAt } from "../../engine/envelope";
import type { EaseName, SceneTime } from "../types";

/** One pulse's shape in ms: rise over `attackMs` (default 0, a snap), hold for `holdMs` (default 0), fall over `releaseMs`; `ease` (default `"outQuad"`) shapes both ramps. */
export interface PulseOptions {
  attackMs?: number;
  holdMs?: number;
  releaseMs: number;
  ease?: EaseName | ((t: number) => number);
}

/** A level 0..1 that fires at each of `times` (scene-local ms, e.g. `useBeatGrid()` bars or `useCues()` values) and falls back to exactly 0 between them; where pulses overlap the strongest wins. `time` is `useTimeline()` or scene-local ms. A pure function of time, so scale, glow or opacity driven by it exports deterministically. Object motion blur shifts `useTimeline()`, so a pulse blurs with its scene: give it an attack of at least one frame (17 ms) so the rise smears rather than ghosting. */
export function pulse(
  time: SceneTime | number,
  times: number | readonly number[],
  opts: PulseOptions,
): number {
  const localMs = typeof time === "number" ? time : time.localMs;
  const starts = typeof times === "number" ? [times] : times;
  let level = 0;
  for (const at of starts) {
    const v = envelopeAt(localMs - at, opts);
    if (v > level) level = v;
  }
  return level;
}
