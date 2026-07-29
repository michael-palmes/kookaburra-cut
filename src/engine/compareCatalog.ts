import type { CompareMaskType } from "./sceneCompare";

/** The comparison mask picker's single source of truth (the transition-catalogue pattern): one row per mask type, structure-pinned in tests against the schema union and the shader dispatch ids so picker and compositor can never drift. `needsAngle`/`needsCenter` gate which mask fields the inspector shows; `hasLine` gates the divider-line chrome rows (the radial sweep has no stable line width, blend has no line at all). */
export interface CompareMaskEntry {
  id: CompareMaskType;
  label: string;
  hint: string;
  needsAngle: boolean;
  needsCenter: boolean;
  hasLine: boolean;
  hasGrip: boolean;
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
  },
  {
    id: "circle",
    label: "Spotlight",
    hint: "The after inside a growing circle",
    needsAngle: false,
    needsCenter: true,
    hasLine: true,
    hasGrip: false,
  },
  {
    id: "radial",
    label: "Sweep",
    hint: "The after sweeps around the centre",
    needsAngle: false,
    needsCenter: true,
    hasLine: false,
    hasGrip: false,
  },
  {
    id: "blend",
    label: "Ghost",
    hint: "The after fades over the before",
    needsAngle: false,
    needsCenter: false,
    hasLine: false,
    hasGrip: false,
  },
];
