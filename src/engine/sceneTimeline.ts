/** Pure global → local time mapping for a sequence of scenes (no React, no clock): scenes lay back-to-back, but a transition makes the next scene start early by its clamped duration (the overlap/cross-dissolve model, so total = Σdurations − Σoverlaps); resolveAt maps a global ms onto the 1 (solo) or 2 (mid-transition) active scenes and their scene-local times. Pure functions, so preview and export agree by construction (see docs/determinism.md). */

/** The composite transition types (see engine/transitionShader.ts): the legacy four (crossfade/dip/slide/wipe) render through the v1 GLSL1 materials, the extended pack (blur/push/zoom/whip/luma/glitch) through the GLSL3 materials, the v14 pack (slice/dissolve/warp) through a third material generation, and the v15 pack (inkbleed through spinblur) through a fourth, so earlier programs stay source-identical. */
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
  | "glitch"
  | "slice"
  | "dissolve"
  | "warp"
  | "inkbleed"
  | "flowmorph"
  | "shockwave"
  | "glasssweep"
  | "rackfocus"
  | "halftone"
  | "lightsweep"
  | "shatter"
  | "pixelstretch"
  | "chromasplit"
  | "datamosh"
  | "prism"
  | "spinblur";

/** Progress easing names; absent means linear, so stored specs without one keep exact bytes. */
export type TransitionEase = "linear" | "smooth" | "snappy";

/** Endpoint-preserving progress easing (0 stays 0, 1 stays 1), applied CPU-side so shaders never know the curve; seams stay byte-equal to the solo neighbours. */
export function applyTransitionEase(ease: TransitionEase | undefined, t: number): number {
  if (ease === "smooth") return t * t * (3 - 2 * t);
  if (ease === "snappy") return 1 - (1 - t) ** 3;
  return t;
}

/** Procedural ramp/aperture shapes: linear/radial/iris are the luma ramps; hex is the rack-focus aperture (the v15 pack reuses the shared shape field with per-type meanings). */
export type TransitionShape = "linear" | "radial" | "iris" | "hex";

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
  /** Unit axis for slide/wipe/push/whip/slice/luma:linear (B enters along +direction). */
  direction?: [number, number];
  /** Dip colour (sRGB hex) for `dip`; defaults to the theme background at composite time. */
  color?: string;
  /** Progress easing; absent = linear (the stored-spec byte contract). */
  ease?: TransitionEase;
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
export function defaultDirection(type: TransitionType): [number, number] {
  switch (type) {
    case "slide":
    case "wipe":
    case "push":
    case "whip":
    case "luma":
    case "slice":
    case "glasssweep":
    case "halftone":
    case "lightsweep":
    case "chromasplit":
    case "datamosh":
      return [1, 0];
    case "inkbleed":
    case "shatter":
    case "pixelstretch":
      return [0, -1];
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
  "slice",
  "dissolve",
  "warp",
  "inkbleed",
  "flowmorph",
  "shockwave",
  "glasssweep",
  "rackfocus",
  "halftone",
  "lightsweep",
  "shatter",
  "pixelstretch",
  "chromasplit",
  "datamosh",
  "prism",
  "spinblur",
];

/** Per-type `intensity` defaults (unused types keep 0). */
const INTENSITY_DEFAULTS: Partial<Record<TransitionType, number>> = {
  blur: 0.05,
  zoom: 0.35,
  whip: 0.12,
  glitch: 0.5,
  slice: 0.35,
  dissolve: 0.35,
  warp: 0.2,
  inkbleed: 0.5,
  flowmorph: 0.4,
  shockwave: 0.5,
  glasssweep: 0.5,
  rackfocus: 0.5,
  halftone: 0.3,
  lightsweep: 0.6,
  shatter: 0.5,
  pixelstretch: 0.5,
  chromasplit: 0.4,
  datamosh: 0.6,
  prism: 0.5,
  spinblur: 0.5,
};

/** v15 per-type defaults for the shared params; older types keep the flat fallbacks below, so their resolution is byte-identical. */
const SOFTNESS_DEFAULTS: Partial<Record<TransitionType, number>> = {
  inkbleed: 0.12,
  shockwave: 0.1,
  glasssweep: 0.18,
  rackfocus: 0.25,
  lightsweep: 0.15,
  pixelstretch: 0.15,
  chromasplit: 0.2,
};

const STEPS_DEFAULTS: Partial<Record<TransitionType, number>> = {
  shockwave: 1,
  datamosh: 10,
  prism: 6,
};

const BLOCKS_DEFAULTS: Partial<Record<TransitionType, [number, number]>> = {
  halftone: [45, 45],
  shatter: [12, 12],
  datamosh: [28, 28],
};

const SHAPE_DEFAULTS: Partial<Record<TransitionType, TransitionShape>> = {
  halftone: "radial",
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
    softness: num(spec.softness, SOFTNESS_DEFAULTS[spec.type] ?? 0.08, 0.005, 0.5),
    center: pair(spec.center, [0.5, 0.5], 0, 1),
    blocks: pair(spec.blocks, BLOCKS_DEFAULTS[spec.type] ?? [24, 14], 1, 128).map(Math.round) as [
      number,
      number,
    ],
    shape:
      spec.shape === "radial" ||
      spec.shape === "iris" ||
      spec.shape === "linear" ||
      spec.shape === "hex"
        ? spec.shape
        : (SHAPE_DEFAULTS[spec.type] ?? "linear"),
    steps: Math.round(num(spec.steps, STEPS_DEFAULTS[spec.type] ?? 12, 1, 60)),
    parallax: num(spec.parallax, 0.5, 0, 1),
  };
}

/** The clamped overlap an outgoing TransitionSpec produces between two neighbouring scene durations; buildSceneTimeline uses this exact formula, so duration edits can re-clamp without duplicating it. */
export function resolveOverlapMs(
  spec: TransitionSpec | undefined,
  prevDurationMs: number,
  nextDurationMs: number,
): number {
  return Math.max(0, Math.min(spec?.durationMs ?? 0, prevDurationMs, nextDurationMs));
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
      const overlap = resolveOverlapMs(spec, prev.durationMs, sc.durationMs);
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

  const linear = spec.durationMs > 0 ? clamp((t - b.startMs) / spec.durationMs, 0, 1) : 1;
  const progress = applyTransitionEase(spec.ease, linear);
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

/** Where scene `index`'s ATTRIBUTION window begins on the global timeline: halfway through its incoming overlap, so the chrome's "current scene" (dividers, bold names, lane targeting) flips mid-transition. Display semantics only; `resolveAt` owns render semantics and never reads this. */
export function attributionStartMs(
  slots: { startMs: number; transitionIn?: { durationMs: number } }[],
  index: number,
): number {
  const slot = slots[index];
  if (!slot || index === 0) return 0;
  return slot.startMs + (slot.transitionIn?.durationMs ?? 0) / 2;
}

/** Every scene's attribution-window start, made strictly increasing (1ms floor): a short scene whose incoming AND outgoing overlaps both consume it would otherwise lose its window entirely and become unselectable through the chrome. */
export function attributionBoundaries(
  slots: { startMs: number; transitionIn?: { durationMs: number } }[],
): number[] {
  const starts: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    starts.push(i === 0 ? 0 : Math.max(attributionStartMs(slots, i), starts[i - 1] + 1));
  }
  return starts;
}

/** The playhead's dominant scene: the editing chrome's shared notion of "the active scene", followed by the edit surfaces, camera mini-timeline and tool overlay. Attribution windows run mid-transition to mid-transition (project ends excepted); out of range keeps the pinned v7 fallback to scene 0. */
export function activeSceneIndex(slots: SceneSlot[], ms: number): number {
  let found = 0;
  const total = timelineTotalMs(slots);
  const starts = attributionBoundaries(slots);
  for (let i = 0; i < slots.length; i++) {
    const end = i + 1 < slots.length ? starts[i + 1] : total;
    if (ms >= starts[i] && ms < end) found = i;
  }
  return found;
}
