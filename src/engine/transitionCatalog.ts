/** The transition picker's catalogue: one row per authorable type, with the UI-facing label, the adaptive-params flags, and the duration each type defaults to when first picked. This is the single source of truth for transition vocabulary in the UI, the helper wizards derive their list from it, and the structure-pin test keeps it aligned with the shader registry (`TYPE_ID`) so the picker and the compositor can't drift. `luma` is surfaced as "Iris wipe" and writes `shape: "iris"`; the linear/radial shapes stay authorable via project.json (the skill REFERENCE table) without widening the picker's v1 surface. */

import type { TransitionShape, TransitionType } from "./sceneTimeline";

export interface TransitionMeta {
  type: TransitionType;
  label: string;
  /** One-line hint under the label. */
  hint: string;
  /** Show the 4-way direction control. */
  needsDirection: boolean;
  /** Show the dip-colour row. */
  needsColor: boolean;
  /** Duration seeded when this type is first picked (an existing edit keeps its own). */
  defaultDurationMs: number;
  /** Extra fields baked into the spec on pick (the luma iris shape). */
  presets?: { shape?: TransitionShape };
}

export const TRANSITION_CATALOG: TransitionMeta[] = [
  {
    type: "crossfade",
    label: "Crossfade",
    hint: "Perceptual dissolve",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
  },
  {
    type: "dip",
    label: "Dip to colour",
    hint: "Out through a colour, back in",
    needsDirection: false,
    needsColor: true,
    defaultDurationMs: 600,
  },
  {
    type: "slide",
    label: "Slide",
    hint: "Both scenes travel together",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 600,
  },
  {
    type: "wipe",
    label: "Wipe",
    hint: "Hard reveal line",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 500,
  },
  {
    type: "blur",
    label: "Blur dissolve",
    hint: "Soft-focus swap",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
  },
  {
    type: "push",
    label: "Push",
    hint: "Incoming covers, outgoing lags",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 500,
  },
  {
    type: "zoom",
    label: "Zoom dissolve",
    hint: "Counter-scaled drift",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
  },
  {
    type: "whip",
    label: "Whip pan",
    hint: "Fast pan under motion blur",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 400,
  },
  {
    type: "luma",
    label: "Iris wipe",
    hint: "Circular reveal",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 600,
    presets: { shape: "iris" },
  },
  {
    type: "glitch",
    label: "Glitch",
    hint: "Hashed block cut",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 400,
  },
  {
    type: "slice",
    label: "Slice",
    hint: "Staggered strips slide away",
    needsDirection: true,
    needsColor: false,
    defaultDurationMs: 600,
  },
  {
    type: "dissolve",
    label: "Dissolve",
    hint: "Organic noise wipe",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 700,
  },
  {
    type: "warp",
    label: "Warp",
    hint: "Lens pull with a subtle split",
    needsDirection: false,
    needsColor: false,
    defaultDurationMs: 500,
  },
];

/** The four authorable axes, labelled by the on-screen travel of the incoming scene. */
export const DIRECTION_OPTIONS: { label: string; value: [number, number] }[] = [
  { label: "Left", value: [1, 0] },
  { label: "Right", value: [-1, 0] },
  { label: "Up", value: [0, 1] },
  { label: "Down", value: [0, -1] },
];
