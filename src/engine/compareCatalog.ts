import type { CompareGripStyle, CompareMaskType } from "./sceneCompare";

/** The comparison mask picker's single source of truth (the transition-catalogue pattern): one row per mask type, structure-pinned in tests against the schema union and the shader dispatch ids so picker and compositor can never drift. `needsAngle`/`needsCenter` gate which mask fields the inspector shows; `hasLine` gates the divider-line chrome rows (the radial sweep has no stable line width, blend has no line at all); `hasSoftness` gates the Edge softness row (blend cross-fades whole frames, so it has no edge to feather and `compareCoverageAt` ignores softness there). */
export interface CompareMaskEntry {
  id: CompareMaskType;
  label: string;
  hint: string;
  needsAngle: boolean;
  needsCenter: boolean;
  hasLine: boolean;
  hasGrip: boolean;
  hasSoftness: boolean;
}

export const COMPARE_MASK_CATALOG: readonly CompareMaskEntry[] = [
  {
    id: "linear",
    label: "Slider",
    hint: "A straight divider at any angle",
    needsAngle: true,
    needsCenter: false,
    hasLine: true,
    hasGrip: true,
    hasSoftness: true,
  },
  {
    id: "circle",
    label: "Spotlight",
    hint: "The after inside a growing circle",
    needsAngle: false,
    needsCenter: true,
    hasLine: true,
    hasGrip: false,
    hasSoftness: true,
  },
  {
    id: "radial",
    label: "Sweep",
    hint: "The after sweeps around the centre",
    needsAngle: false,
    needsCenter: true,
    hasLine: false,
    hasGrip: false,
    hasSoftness: true,
  },
  {
    id: "blend",
    label: "Ghost",
    hint: "The after fades over the before",
    needsAngle: false,
    needsCenter: false,
    hasLine: false,
    hasGrip: false,
    hasSoftness: false,
  },
];

/** The grip-handle picker's single source of truth: one row per handle style, structure-pinned against the schema union and the shader's dispatch ids so the picker and the compositor can never drift. Chevrons leads because it is the default and the legacy `grip: true` shape. */
export interface CompareGripEntry {
  id: CompareGripStyle;
  label: string;
  hint: string;
}

export const COMPARE_GRIP_CATALOG: readonly CompareGripEntry[] = [
  { id: "chevrons", label: "Chevrons", hint: "A ring with chevrons either side" },
  { id: "dot", label: "Dot", hint: "A plain filled circle" },
  { id: "bar", label: "Bar", hint: "A rounded pill riding the divider" },
  { id: "arrows", label: "Arrows", hint: "Two arrowheads facing outwards" },
];
