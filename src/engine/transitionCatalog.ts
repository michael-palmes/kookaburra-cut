/** The transition picker's catalogue: one row per authorable type, with the UI-facing label, the feel group it files under, the adaptive-params flags, a declarative param schema the picker renders generically, and the duration each type defaults to when first picked. This is the single source of truth for transition vocabulary in the UI, the helper wizards derive their list from it, and the structure-pin test keeps it aligned with the shader registry (`TYPE_ID`) so the picker and the compositor can't drift. `luma` is surfaced as "Iris wipe" and writes `shape: "iris"`; the linear/radial shapes stay authorable via project.json (the skill REFERENCE table) without widening the picker's surface. */

import type { TransitionShape, TransitionType } from "./sceneTimeline";

/** One authorable control on a transition. `key` names an existing shared TransitionSpec field; the label is per-type, so shared keys read naturally ("softness" is "Edge softness" on one type, "Bar width" on another). Number ranges must sit inside resolveTransitionParams' clamps (pinned by test). */
export type TransitionParamDef =
  | {
      kind: "number";
      key: "intensity" | "softness" | "steps" | "parallax" | "blocksX" | "blocksY";
      label: string;
      default: number;
      min: number;
      max: number;
      step: number;
    }
  | { kind: "point"; key: "center"; label: string; default: [number, number] }
  | {
      kind: "choice";
      key: "shape";
      label: string;
      options: { value: TransitionShape; label: string }[];
      default: TransitionShape;
    };

/** Picker section groups, in display order. */
export type TransitionFeel = "dissolve" | "reveal" | "motion" | "digital";

export const FEEL_ORDER: readonly TransitionFeel[] = ["dissolve", "reveal", "motion", "digital"];

export const FEEL_LABELS: Record<TransitionFeel, string> = {
  dissolve: "Dissolves & focus",
  reveal: "Wipes & reveals",
  motion: "Motion",
  digital: "Digital & bold",
};

export interface TransitionMeta {
  type: TransitionType;
  label: string;
  /** One-line hint under the label. */
  hint: string;
  /** Picker section this type files under. */
  feel: TransitionFeel;
  /** Show the 4-way direction control. */
  needsDirection: boolean;
  /** Show the dip-colour row. */
  needsColor: boolean;
  /** Duration seeded when this type is first picked (an existing edit keeps its own). */
  defaultDurationMs: number;
  /** Extra fields baked into the spec on pick (the luma iris shape). */
  presets?: { shape?: TransitionShape; color?: string };
  /** Advanced controls the picker renders; absent = duration/ease (+ direction/colour) only. */
  params?: TransitionParamDef[];
}

export const TRANSITION_CATALOG: TransitionMeta[] = [
  {
    type: "crossfade",
    label: "Crossfade",
    hint: "Perceptual dissolve",
    feel: "dissolve",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
  },
  {
    type: "blur",
    label: "Blur dissolve",
    hint: "Soft-focus swap",
    feel: "dissolve",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Blur radius",
        default: 0.05,
        min: 0,
        max: 0.2,
        step: 0.005,
      },
    ],
  },
  {
    type: "zoom",
    label: "Zoom dissolve",
    hint: "Counter-scaled drift",
    feel: "dissolve",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Zoom amount",
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
      },
      { kind: "point", key: "center", label: "Focal point", default: [0.5, 0.5] },
    ],
  },
  {
    type: "dissolve",
    label: "Dissolve",
    hint: "Organic noise wipe",
    feel: "dissolve",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 700,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Grain scale",
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "softness",
        label: "Edge softness",
        default: 0.08,
        min: 0.005,
        max: 0.5,
        step: 0.005,
      },
    ],
  },
  {
    type: "wipe",
    label: "Wipe",
    hint: "Hard reveal line",
    feel: "reveal",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 500,
  },
  {
    type: "luma",
    label: "Iris wipe",
    hint: "Circular reveal",
    feel: "reveal",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
    presets: { shape: "iris" },
    params: [
      {
        kind: "number",
        key: "softness",
        label: "Edge softness",
        default: 0.08,
        min: 0.005,
        max: 0.5,
        step: 0.005,
      },
      { kind: "point", key: "center", label: "Focal point", default: [0.5, 0.5] },
      {
        kind: "choice",
        key: "shape",
        label: "Ramp",
        options: [
          { value: "iris", label: "Iris" },
          { value: "radial", label: "Radial" },
          { value: "linear", label: "Linear" },
        ],
        default: "iris",
      },
    ],
  },
  {
    type: "dip",
    label: "Dip to colour",
    hint: "Out through a colour, back in",
    feel: "reveal",
    needsDirection: false,
    needsColor: true,
    defaultDurationMs: 600,
  },
  {
    type: "slide",
    label: "Slide",
    hint: "Both scenes travel together",
    feel: "motion",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 600,
  },
  {
    type: "push",
    label: "Push",
    hint: "Incoming covers, outgoing lags",
    feel: "motion",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 500,
    params: [
      {
        kind: "number",
        key: "parallax",
        label: "Outgoing lag",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
  {
    type: "whip",
    label: "Whip pan",
    hint: "Fast pan under motion blur",
    feel: "motion",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 400,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Blur spread",
        default: 0.12,
        min: 0,
        max: 0.5,
        step: 0.01,
      },
    ],
  },
  {
    type: "slice",
    label: "Slice",
    hint: "Staggered strips slide away",
    feel: "motion",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 600,
    params: [
      { kind: "number", key: "blocksX", label: "Strips", default: 24, min: 2, max: 64, step: 1 },
      {
        kind: "number",
        key: "intensity",
        label: "Stagger",
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
  {
    type: "warp",
    label: "Warp",
    hint: "Lens pull with a subtle split",
    feel: "motion",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 500,
    params: [
      { kind: "number", key: "intensity", label: "Pull", default: 0.2, min: 0, max: 1, step: 0.05 },
      { kind: "point", key: "center", label: "Focal point", default: [0.5, 0.5] },
    ],
  },
  {
    type: "glitch",
    label: "Glitch",
    hint: "Hashed block cut",
    feel: "digital",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 400,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Severity",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "blocksX",
        label: "Blocks across",
        default: 24,
        min: 4,
        max: 64,
        step: 1,
      },
      {
        kind: "number",
        key: "blocksY",
        label: "Blocks down",
        default: 14,
        min: 2,
        max: 64,
        step: 1,
      },
      {
        kind: "number",
        key: "steps",
        label: "Re-roll steps",
        default: 12,
        min: 1,
        max: 60,
        step: 1,
      },
    ],
  },
];

/** The four authorable axes, labelled by the on-screen travel of the incoming scene. */
export const DIRECTION_OPTIONS: { label: string; value: [number, number] }[] = [
  { label: "Left", value: [1, 0] },
  { label: "Right", value: [-1, 0] },
  { label: "Up", value: [0, 1] },
  { label: "Down", value: [0, -1] },
];
