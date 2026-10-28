import { applyTransitionEase, type SceneSlot } from "./sceneTimeline";

/** The GPU acceptance check behind `kookaburra:run --action transitioncheck`: a crossfade's midpoint must blend both scenes, which a render-target collision (the incoming comparison overwriting the outgoing side) silently breaks while Verify ×2 still passes. */

/** One crossfade's probe instants (project ms): the outgoing scene alone on the frame before the overlap, the overlap's midpoint, and the incoming scene alone once it ends. */
export interface CrossfadeProbe {
  fromIndex: number;
  toIndex: number;
  beforeMs: number;
  midMs: number;
  afterMs: number;
  /** The outgoing scene's weight at the midpoint, after the transition's ease. */
  expected: number;
}

/** How far a measured weight may sit from the expected one: scenes keep animating across the overlap, so the solo frames either side only approximate the sides at the midpoint. */
export const CROSSFADE_TOLERANCE = 0.15;

/** Below this mean squared channel difference per pixel the two scenes look alike, so no weight can be read. */
const MIN_SPREAD = 48;

export function crossfadeProbes(slots: readonly SceneSlot[], fps: number): CrossfadeProbe[] {
  const frameMs = 1000 / fps;
  const probes: CrossfadeProbe[] = [];
  for (const slot of slots) {
    const spec = slot.transitionIn;
    const prev = slots[slot.index - 1];
    if (spec?.type !== "crossfade" || !prev) continue;
    const beforeMs = Math.max(prev.startMs, slot.startMs - frameMs);
    const after = slots[slot.index + 1];
    // A scene eaten by its other transition has no solo frame to compare against.
    if (beforeMs < prev.startMs + (prev.transitionIn?.durationMs ?? 0)) continue;
    if (after && after.startMs <= prev.endMs) continue;
    probes.push({
      fromIndex: prev.index,
      toIndex: slot.index,
      beforeMs,
      midMs: slot.startMs + spec.durationMs / 2,
      afterMs: prev.endMs,
      expected: 1 - applyTransitionEase(spec.ease, 0.5),
    });
  }
  return probes;
}

/** The least-squares weight `w` in `mid ≈ w·before + (1 − w)·after` over every RGB channel, or null when the two frames are too alike to tell apart. */
export function outgoingWeight(
  before: Uint8Array,
  mid: Uint8Array,
  after: Uint8Array,
): number | null {
  let num = 0;
  let den = 0;
  for (let i = 0; i < before.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const spread = before[i + c] - after[i + c];
      num += (mid[i + c] - after[i + c]) * spread;
      den += spread * spread;
    }
  }
  return den < (before.length / 4) * MIN_SPREAD ? null : num / den;
}
