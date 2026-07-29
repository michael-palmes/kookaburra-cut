import type { SceneDoc } from "./sceneDocSchema";
import type { SceneRenderState } from "./sceneState";
import type { Resolved } from "./sceneTimeline";

/** The before/after comparison engine: pure helpers deriving side B's doc from the base (side A), normalising the compare block, and resolving the per-frame divider. The compositor renders side A and side B to the transition machinery's A/B targets and composites them under the mask; both preview and export resolve through `resolveCompareFrame` so they cannot drift. Divider values are CPU-computed here, never time-derived in GLSL (the transition invariant). See docs/determinism.md. */

/** A normalised comparison, precomputed once per doc: mask params with defaults baked and track keys sorted. */
export interface CompareSpec {
  /** The divider LINE's angle in degrees (90 = vertical divider sweeping horizontally). */
  angleDeg: number;
  /** Feathered edge half-width in normalised units; 0 = hard edge. */
  softness: number;
  /** Static divider position, used when `keys` is empty. */
  value: number;
  /** Sorted (atMs ascending) divider keys; linear interpolation between them. */
  keys: readonly { atMs: number; value: number }[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Normalise a doc's compare block; null when the doc has none. */
export function compareSpecOf(doc: SceneDoc | undefined): CompareSpec | null {
  const c = doc?.compare;
  if (!c) return null;
  const keys = [...(c.track?.keys ?? [])]
    .map((k) => ({ atMs: k.atMs, value: clamp01(k.value) }))
    .sort((a, b) => a.atMs - b.atMs);
  return {
    angleDeg: c.mask?.angleDeg ?? 90,
    softness: c.mask?.softness ?? 0,
    value: clamp01(c.value ?? 0.5),
    keys,
  };
}

/** Sample the divider at a scene-local time: linear interpolation between keys, clamped to the end keys; the static value with no keys. */
export function compareValueAt(spec: CompareSpec, localMs: number): number {
  const keys = spec.keys;
  if (keys.length === 0) return spec.value;
  if (localMs <= keys[0].atMs) return keys[0].value;
  const last = keys[keys.length - 1];
  if (localMs >= last.atMs) return last.value;
  for (let i = 1; i < keys.length; i++) {
    if (localMs <= keys[i].atMs) {
      const a = keys[i - 1];
      const b = keys[i];
      const t = b.atMs === a.atMs ? 1 : (localMs - a.atMs) / (b.atMs - a.atMs);
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

/** Derive side B's doc from the base: the base doc with `compare.b`'s overrides applied and the compare block itself removed (so side B can never recurse). Null when the doc has no compare block. */
export function deriveCompareBDoc(doc: SceneDoc | undefined): SceneDoc | null {
  const c = doc?.compare;
  if (!doc || !c) return null;
  const b = structuredClone(doc);
  b.compare = undefined;
  const side = c.b;
  if (!side) return b;
  if (side.themeId !== undefined) b.themeId = side.themeId;
  if (side.background !== undefined) b.background = side.background;
  if (side.lighting !== undefined) b.lighting = side.lighting;
  if (side.media) {
    for (const device of b.devices ?? []) {
      const media = side.media[device.id];
      if (media) device.media = media;
    }
  }
  return b;
}

/** Everything the compositor needs for one compare frame: the divider sampled at the scene's local time plus each side's root-scene render state (absent when the project never opts into themed scene state). */
export interface CompareFrame {
  index: number;
  /** Divider position 0..1 along the sweep axis (below = side A / before). */
  value: number;
  angleDeg: number;
  softness: number;
  stateA?: SceneRenderState;
  stateB?: SceneRenderState;
}

/** Resolve the frame's compare plan; null when the active scene has no comparison. Transition frames (two active scenes) deliberately resolve null: the compositor's transition path then blends side A only (the v1 interop rule; hard cuts show the full comparison). */
export function resolveCompareFrame(
  specs: readonly (CompareSpec | null)[],
  statesA: readonly SceneRenderState[] | null,
  statesB: readonly (SceneRenderState | null)[] | null,
  resolved: Resolved,
): CompareFrame | null {
  if (resolved.active.length !== 1) return null;
  const active = resolved.active[0];
  const spec = specs[active.index];
  if (!spec) return null;
  return {
    index: active.index,
    value: compareValueAt(spec, active.localMs),
    angleDeg: spec.angleDeg,
    softness: spec.softness,
    stateA: statesA?.[active.index],
    stateB: statesB?.[active.index] ?? undefined,
  };
}
