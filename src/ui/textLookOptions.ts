import type { TextLookSpec } from "../theme/tokens";
import {
  DEFAULT_LOOK_ANGLE_DEG,
  DEFAULT_LOOK_CURVE_DEG,
  DEFAULT_LOOK_HOLLOW,
  DEFAULT_LOOK_INTENSITY,
  DEFAULT_LOOK_OFFSET_EM,
  DEFAULT_LOOK_STROKE_EM,
  isTextLookName,
  type TextLookName,
} from "../toolkit/text/looks";

/** Pure vocabulary + spec builders for the text-style (text look) picker, the textAnimationOptions pattern: every sidecar shape emitted here is structure-pinned in unit tests against the shared `parseTextLookSpec`, so a card can never silently write a spec that degrades to "no override". */

/** One picker card. Param capabilities drive the adaptive panel. */
export interface TextLookMeta {
  preset: TextLookName;
  label: string;
  hint: string;
  hasColorA?: boolean;
  hasColorB?: boolean;
  hasAngle?: boolean;
  hasStroke?: boolean;
  hasHollow?: boolean;
  hasIntensity?: boolean;
  hasOffset?: boolean;
  hasCurve?: boolean;
  /** Colour well label override (default "Colour"). */
  colorALabel?: string;
  /** The renderer's colorA fallback when unset (default: the theme accent). */
  colorADefault?: string;
}

/** Card order = grid order (the Theme-default chip renders before all of these). */
export const TEXT_LOOK_CATALOG: readonly TextLookMeta[] = [
  { preset: "none", label: "None", hint: "The plain theme fill, no style preset" },
  {
    preset: "gradient",
    label: "Gradient",
    hint: "A two-colour blend across the text",
    hasColorA: true,
    hasColorB: true,
    hasAngle: true,
  },
  {
    preset: "outline",
    label: "Outline",
    hint: "A drawn stroke around every glyph",
    hasColorA: true,
    hasStroke: true,
    hasHollow: true,
  },
  {
    preset: "neon",
    label: "Neon",
    hint: "A persistent glow held around the text",
    hasColorA: true,
    hasIntensity: true,
  },
  {
    preset: "offset-print",
    label: "Offset print",
    hint: "A retro duotone under-layer behind the text",
    hasColorA: true,
    hasOffset: true,
  },
  {
    preset: "highlight-block",
    label: "Highlight block",
    hint: "Accent blocks held behind each word",
    hasColorA: true,
  },
  {
    preset: "frosted",
    label: "Frosted glass",
    hint: "A soft glass read with a faint shine",
    hasIntensity: true,
  },
  { preset: "arc", label: "Arc", hint: "Glyphs bend along a circular arc", hasCurve: true },
  {
    preset: "glass-3d",
    label: "Glass (3D)",
    hint: "Extruded transmission glass with real depth",
    hasColorA: true,
    hasIntensity: true,
    colorALabel: "Tint",
    colorADefault: "#ffffff",
  },
  {
    preset: "chrome-3d",
    label: "Chrome (3D)",
    hint: "Extruded mirror metal, tinted",
    hasColorA: true,
  },
] as const;

export function textLookMeta(preset: string): TextLookMeta | undefined {
  return TEXT_LOOK_CATALOG.find((meta) => meta.preset === preset);
}

/** The picker's working state; everything the adaptive panel edits. Null colours mean "themed". */
export interface TextLookDraft {
  preset: TextLookName;
  colorA: string | null;
  colorB: string | null;
  angleDeg: number;
  strokeEm: number;
  hollow: boolean;
  intensity: number;
  offsetEm: number;
  curveDeg: number;
}

export function defaultLookDraft(preset: TextLookName): TextLookDraft {
  return {
    preset,
    colorA: null,
    colorB: null,
    angleDeg: DEFAULT_LOOK_ANGLE_DEG,
    strokeEm: DEFAULT_LOOK_STROKE_EM,
    hollow: DEFAULT_LOOK_HOLLOW,
    intensity: DEFAULT_LOOK_INTENSITY,
    offsetEm: DEFAULT_LOOK_OFFSET_EM,
    curveDeg: DEFAULT_LOOK_CURVE_DEG,
  };
}

/** The whole-spec sidecar shape for a draft; what `doc.textLook` receives. Only the fields the preset uses are written, and only away from their resolver defaults. */
export function lookDraftToSpec(draft: TextLookDraft): TextLookSpec {
  const spec: TextLookSpec = { preset: draft.preset };
  const meta = textLookMeta(draft.preset);
  if (!meta) return spec;
  if (meta.hasColorA && draft.colorA) spec.colorA = draft.colorA;
  if (meta.hasColorB && draft.colorB) spec.colorB = draft.colorB;
  if (meta.hasAngle && draft.angleDeg !== DEFAULT_LOOK_ANGLE_DEG) spec.angleDeg = draft.angleDeg;
  if (meta.hasStroke && draft.strokeEm !== DEFAULT_LOOK_STROKE_EM) spec.strokeEm = draft.strokeEm;
  if (meta.hasHollow && draft.hollow !== DEFAULT_LOOK_HOLLOW) spec.hollow = draft.hollow;
  if (meta.hasIntensity && draft.intensity !== DEFAULT_LOOK_INTENSITY) {
    spec.intensity = draft.intensity;
  }
  if (meta.hasOffset && draft.offsetEm !== DEFAULT_LOOK_OFFSET_EM) spec.offsetEm = draft.offsetEm;
  if (meta.hasCurve && draft.curveDeg !== DEFAULT_LOOK_CURVE_DEG) spec.curveDeg = draft.curveDeg;
  return spec;
}

/** Seed a draft from an existing spec (unknown preset names coerce to "none", like the resolver). */
export function lookSpecToDraft(spec: TextLookSpec): TextLookDraft {
  const draft = defaultLookDraft(isTextLookName(spec.preset) ? spec.preset : "none");
  if (spec.colorA !== undefined) draft.colorA = spec.colorA;
  if (spec.colorB !== undefined) draft.colorB = spec.colorB;
  if (spec.angleDeg !== undefined) draft.angleDeg = spec.angleDeg;
  if (spec.strokeEm !== undefined) draft.strokeEm = spec.strokeEm;
  if (spec.hollow !== undefined) draft.hollow = spec.hollow;
  if (spec.intensity !== undefined) draft.intensity = spec.intensity;
  if (spec.offsetEm !== undefined) draft.offsetEm = spec.offsetEm;
  if (spec.curveDeg !== undefined) draft.curveDeg = spec.curveDeg;
  return draft;
}

/** One-line description of a spec; the Theme-default chip's hint. */
export function describeLookSpec(spec: TextLookSpec | undefined): string {
  if (!spec || spec.preset === "none") return "No style preset";
  return textLookMeta(spec.preset)?.label ?? spec.preset;
}

/** Display-only stand-in for the resolver's darkened gradient stop B; the render side owns the real value. */
export function darkenedStopB(hex: string): string {
  const raw = hex.trim().replace(/^#/, "");
  const expanded =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return hex;
  const channels = [0, 2, 4].map((at) =>
    Math.round(Number.parseInt(expanded.slice(at, at + 2), 16) * 0.62),
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
