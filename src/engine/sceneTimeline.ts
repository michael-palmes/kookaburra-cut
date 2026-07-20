/** Pure global → local time mapping for a sequence of scenes (no React, no clock): scenes lay back-to-back, but a transition makes the next scene start early by its clamped duration (the overlap/cross-dissolve model, so total = Σdurations − Σoverlaps); resolveAt maps a global ms onto the 1 (solo) or 2 (mid-transition) active scenes and their scene-local times. Pure functions, so preview and export agree by construction (see docs/determinism.md). */

/** The composite transition types (see engine/transitionShader.ts): the legacy four (crossfade/dip/slide/wipe) render through the v1 GLSL1 materials, the extended pack (blur/push/zoom/whip/luma/glitch) through the GLSL3 materials. */
export type TransitionType =
  | "crossfade"
  | "dip"
  | "slide"
  | "wipe"
  | "blur"
  | "push"
  | "zoom"
  | "whip"
  | "luma"
  | "glitch";

/** Procedural luma-wipe ramp shapes. */
export type TransitionShape = "linear" | "radial" | "iris";

/** Resolved per-type parameters, all defaults baked (see resolveTransitionParams). */
export interface TransitionParams {
  /** Effect strength: blur radius / zoom amount / whip spread / glitch severity. */
  intensity: number;
  /** Luma edge softness (ramp units). */
  softness: number;
  /** Zoom/luma focal point in UV space. */
  center: [number, number];
  /** Glitch block grid (columns, rows). */
  blocks: [number, number];
  /** Luma ramp shape. */
  shape: TransitionShape;
  /** Glitch hold-steps: progress quantization for block re-rolls. */
  steps: number;
  /** Push: fraction of full travel the OUTGOING scene moves (cover/reveal lag). */
  parallax: number;
}

/** A transition OUT of a scene into the next one, as authored in project.json (manifest v2; legacy files stored it on the incoming scene and are shifted by the loader). */
export interface TransitionSpec extends Partial<TransitionParams> {
  type: TransitionType;
  /** Overlap duration in ms. Clamped to the neighbouring scene durations when built. */
  durationMs: number;
  /** Unit axis for slide/wipe/push/whip/luma:linear (B enters along +direction). */
  direction?: [number, number];
  /** Dip colour (sRGB hex) for `dip`; defaults to the theme background at composite time. */
  color?: string;
}

/** Minimal scene shape the timeline needs (decoupled from LoadedProject for testability). */
export interface TimelineSceneInput {
  id: string;
  durationMs: number;
  /** Transition out of this scene into the next one (ignored on the last scene). */
  transition?: TransitionSpec;
}

/** A scene placed on the global timeline. */
export interface SceneSlot {
  index: number;
  id: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Present only when this slot overlaps the previous one; durationMs is the clamped overlap. */
  transitionIn?: TransitionSpec;
}

/** A scene that is on-screen at a given instant, with its scene-local time. */
export interface ActiveScene {
  index: number;
  localMs: number;
}

/** A transition in progress at a given instant. */
export interface ResolvedTransition {
  type: TransitionType;
  direction: [number, number];
  /** Per-type parameters with all defaults baked. */
  params: TransitionParams;
  color?: string;
  /** 0 → 1 across the overlap window. */
  progress: number;
  /** Outgoing (A) scene index. */
  fromIndex: number;
  /** Incoming (B) scene index. */
  toIndex: number;
}

/** What is on-screen at an instant: 1 active scene (solo) or 2 (+ a transition). */
export interface Resolved {
  active: ActiveScene[];
  transition?: ResolvedTransition;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Default enter axis for directional transitions. */
function defaultDirection(type: TransitionType): [number, number] {
  switch (type) {
    case "slide":
    case "wipe":
    case "push":
    case "whip":
    case "luma":
      return [1, 0];
    default:
      return [0, 0];
  }
}

const KNOWN_TYPES: readonly TransitionType[] = [
  "crossfade",
  "dip",
  "slide",
  "wipe",
  "blur",
  "push",
  "zoom",
  "whip",
  "luma",
  "glitch",
];

/** Per-type `intensity` defaults (unused types keep 0). */
const INTENSITY_DEFAULTS: Partial<Record<TransitionType, number>> = {
  blur: 0.05,
  zoom: 0.35,
  whip: 0.12,
  glitch: 0.5,
};

/** Normalizes an authored spec: unknown types degrade to `crossfade` with a warning, since workspace project.json is hand- or Claude-edited and a typo must never feed an undefined uniform, so the timeline only ever carries known types. */
export function normalizeTransitionType(type: string): TransitionType {
  if ((KNOWN_TYPES as readonly string[]).includes(type)) return type as TransitionType;
  console.warn(`[timeline] unknown transition type "${type}" — falling back to crossfade`);
  return "crossfade";
}

/** Bakes a spec's per-type parameters: defaults applied, numerics clamped to safe ranges; pure, since the resolved params are part of the frame's input set (export contract). */
export function resolveTransitionParams(spec: TransitionSpec): TransitionParams {
  const num = (v: number | undefined, dflt: number, lo: number, hi: number) =>
    clamp(typeof v === "number" && Number.isFinite(v) ? v : dflt, lo, hi);
  const pair = (
    v: [number, number] | undefined,
    dflt: [number, number],
    lo: number,
    hi: number,
  ): [number, number] =>
    Array.isArray(v) && v.length === 2
      ? [num(v[0], dflt[0], lo, hi), num(v[1], dflt[1], lo, hi)]
      : dflt;
  return {
    intensity: num(spec.intensity, INTENSITY_DEFAULTS[spec.type] ?? 0, 0, 1),
    softness: num(spec.softness, 0.08, 0.005, 0.5),
    center: pair(spec.center, [0.5, 0.5], 0, 1),
    blocks: pair(spec.blocks, [24, 14], 1, 128).map(Math.round) as [number, number],
    shape:
      spec.shape === "radial" || spec.shape === "iris" || spec.shape === "linear"
        ? spec.shape
        : "linear",
    steps: Math.round(num(spec.steps, 12, 1, 60)),
    parallax: num(spec.parallax, 0.5, 0, 1),
  };
}

/** Places scenes on the global timeline; the previous scene's outgoing transition pulls this scene's start back by the overlap, clamped so it never exceeds either neighbour's duration (so starts stay ≥ 0). */
export function buildSceneTimeline(scenes: TimelineSceneInput[]): SceneSlot[] {
  const slots: SceneSlot[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    let startMs = 0;
    let transitionIn: TransitionSpec | undefined;
    if (i > 0) {
      const prev = slots[i - 1];
      const spec = scenes[i - 1].transition;
      const requested = spec?.durationMs ?? 0;
      const overlap = Math.max(0, Math.min(requested, prev.durationMs, sc.durationMs));
      startMs = prev.endMs - overlap;
      transitionIn =
        spec && overlap > 0
          ? {
              ...spec,
              type: normalizeTransitionType(spec.type),
              durationMs: overlap,
            }
          : undefined;
    }
    slots.push({
      index: i,
      id: sc.id,
      startMs,
      durationMs: sc.durationMs,
      endMs: startMs + sc.durationMs,
      transitionIn,
    });
  }
  return slots;
}

/** Total project length: the end of the last slot (0 for an empty project). */
export function timelineTotalMs(slots: SceneSlot[]): number {
  return slots.length ? slots[slots.length - 1].endMs : 0;
}

/** Resolves which scene(s) are active at a global time, with scene-local times and any transition in progress; time is clamped to `[0, total]`, the final instant maps to the last scene at its end, and intervals are half-open `[start, end)` so a boundary belongs to the next scene. */
export function resolveAt(slots: SceneSlot[], tMs: number): Resolved {
  if (slots.length === 0) return { active: [] };

  const total = timelineTotalMs(slots);
  const t = clamp(tMs, 0, total);

  const candidates = slots.filter((s) => t >= s.startMs && t < s.endMs);

  if (candidates.length === 0) {
    // t === total (or a gap that shouldn't occur): the last scene at its end.
    const last = slots[slots.length - 1];
    return { active: [{ index: last.index, localMs: last.durationMs }] };
  }

  if (candidates.length === 1) {
    const s = candidates[0];
    return { active: [{ index: s.index, localMs: clamp(t - s.startMs, 0, s.durationMs) }] };
  }

  // Two (or, defensively, more) overlap → the most recent consecutive pair is transitioning.
  const b = candidates[candidates.length - 1];
  const a = candidates[candidates.length - 2];
  const spec = b.transitionIn;

  if (!spec) {
    // No transition metadata (shouldn't happen; overlaps only exist with a transition).
    return { active: [{ index: b.index, localMs: clamp(t - b.startMs, 0, b.durationMs) }] };
  }

  const progress = spec.durationMs > 0 ? clamp((t - b.startMs) / spec.durationMs, 0, 1) : 1;
  return {
    active: [
      { index: a.index, localMs: clamp(t - a.startMs, 0, a.durationMs) },
      { index: b.index, localMs: clamp(t - b.startMs, 0, b.durationMs) },
    ],
    transition: {
      type: spec.type,
      direction: spec.direction ?? defaultDirection(spec.type),
      params: resolveTransitionParams(spec),
      color: spec.color,
      progress,
      fromIndex: a.index,
      toIndex: b.index,
    },
  };
}

/** The playhead's dominant scene (the later scene inside a transition overlap): the editing chrome's shared notion of "the active scene", followed by the edit surfaces, camera mini-timeline and tool overlay (moved here from EditBar since it's pure slot math and shouldn't couple to a component module). */
export function activeSceneIndex(slots: SceneSlot[], ms: number): number {
  let found = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (ms >= s.startMs && ms < s.startMs + s.durationMs) found = i;
  }
  return found;
}
