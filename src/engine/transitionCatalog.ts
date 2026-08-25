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
    type: "rackfocus",
    label: "Rack focus",
    hint: "Defocus to bokeh, refocus",
    feel: "dissolve",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 800,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Max defocus",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "softness",
        label: "Highlight bloom",
        default: 0.25,
        min: 0.005,
        max: 0.5,
        step: 0.01,
      },
      {
        kind: "choice",
        key: "shape",
        label: "Aperture",
        options: [
          { value: "linear", label: "Disc" },
          { value: "hex", label: "Hex" },
        ],
        default: "linear",
      },
    ],
  },
  {
    type: "flowmorph",
    label: "Flow morph",
    hint: "Currents carry the frame",
    feel: "dissolve",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 900,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Flow strength",
        default: 0.4,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "parallax",
        label: "Drift asymmetry",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
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
    type: "inkbleed",
    label: "Ink bleed",
    hint: "Wicks through with an irregular edge",
    feel: "reveal",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 800,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Bleed scale",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "softness",
        label: "Edge width",
        default: 0.12,
        min: 0.02,
        max: 0.5,
        step: 0.01,
      },
    ],
  },
  {
    type: "halftone",
    label: "Halftone",
    hint: "Print screens through an ink plate",
    feel: "reveal",
    needsDirection: true,
    needsColor: true,
    defaultDurationMs: 700,
    presets: { shape: "radial" },
    params: [
      {
        kind: "number",
        key: "blocksX",
        label: "Dot pitch",
        default: 45,
        min: 8,
        max: 96,
        step: 1,
      },
      {
        kind: "number",
        key: "intensity",
        label: "Ink gain",
        default: 0.3,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "choice",
        key: "shape",
        label: "Screen",
        options: [
          { value: "radial", label: "Dot" },
          { value: "linear", label: "Line" },
        ],
        default: "radial",
      },
    ],
  },
  {
    type: "lightsweep",
    label: "Light sweep",
    hint: "Anamorphic streak flare",
    feel: "reveal",
    needsDirection: true,
    needsColor: true,
    defaultDurationMs: 500,
    presets: { color: "#ffffff" },
    params: [
      {
        kind: "number",
        key: "softness",
        label: "Streak width",
        default: 0.15,
        min: 0.03,
        max: 0.4,
        step: 0.01,
      },
      {
        kind: "number",
        key: "intensity",
        label: "Bloom",
        default: 0.6,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
  {
    type: "glasssweep",
    label: "Glass sweep",
    hint: "Refracting bar with dispersion",
    feel: "reveal",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 700,
    params: [
      {
        kind: "number",
        key: "softness",
        label: "Bar width",
        default: 0.18,
        min: 0.05,
        max: 0.4,
        step: 0.01,
      },
      {
        kind: "number",
        key: "intensity",
        label: "Refraction",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
  {
    type: "shockwave",
    label: "Shockwave",
    hint: "Refractive pressure front",
    feel: "reveal",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
    params: [
      { kind: "point", key: "center", label: "Origin", default: [0.5, 0.5] },
      {
        kind: "number",
        key: "intensity",
        label: "Refraction",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "softness",
        label: "Front width",
        default: 0.1,
        min: 0.02,
        max: 0.3,
        step: 0.01,
      },
      {
        kind: "number",
        key: "steps",
        label: "Aftershocks",
        default: 1,
        min: 1,
        max: 3,
        step: 1,
      },
    ],
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
    type: "spinblur",
    label: "Spin blur",
    hint: "Rotational whip",
    feel: "motion",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 400,
    params: [
      { kind: "point", key: "center", label: "Focal point", default: [0.5, 0.5] },
      {
        kind: "number",
        key: "intensity",
        label: "Whirl",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "choice",
        key: "shape",
        label: "Spin",
        options: [
          { value: "linear", label: "Clockwise" },
          { value: "radial", label: "Anticlockwise" },
        ],
        default: "linear",
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
    type: "prism",
    label: "Prism fold",
    hint: "Faceted refraction unfold",
    feel: "motion",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 700,
    params: [
      {
        kind: "number",
        key: "steps",
        label: "Facets",
        default: 6,
        min: 3,
        max: 16,
        step: 1,
      },
      {
        kind: "number",
        key: "intensity",
        label: "Refraction spin",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      { kind: "point", key: "center", label: "Origin", default: [0.5, 0.5] },
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
  {
    type: "datamosh",
    label: "Datamosh",
    hint: "Macroblock smear and refresh",
    feel: "digital",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 500,
    params: [
      {
        kind: "number",
        key: "blocksX",
        label: "Blocks across",
        default: 28,
        min: 8,
        max: 64,
        step: 1,
      },
      {
        kind: "number",
        key: "steps",
        label: "Refresh stages",
        default: 10,
        min: 2,
        max: 30,
        step: 1,
      },
      {
        kind: "number",
        key: "intensity",
        label: "Mosh strength",
        default: 0.6,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
  {
    type: "chromasplit",
    label: "Chroma split",
    hint: "Channels peel and reconverge",
    feel: "digital",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 500,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Split distance",
        default: 0.4,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "softness",
        label: "Ghost dissolve",
        default: 0.2,
        min: 0.02,
        max: 0.5,
        step: 0.01,
      },
    ],
  },
  {
    type: "pixelstretch",
    label: "Pixel stretch",
    hint: "Luma-keyed smear collapse",
    feel: "digital",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 600,
    params: [
      {
        kind: "number",
        key: "intensity",
        label: "Streak length",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "softness",
        label: "Key band",
        default: 0.15,
        min: 0.02,
        max: 0.5,
        step: 0.01,
      },
    ],
  },
  {
    type: "shatter",
    label: "Shatter",
    hint: "Shards drift out, lit edges",
    feel: "digital",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 700,
    params: [
      {
        kind: "number",
        key: "blocksX",
        label: "Cell density",
        default: 12,
        min: 4,
        max: 40,
        step: 1,
      },
      {
        kind: "number",
        key: "intensity",
        label: "Scatter",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: "number",
        key: "parallax",
        label: "Stagger",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
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
