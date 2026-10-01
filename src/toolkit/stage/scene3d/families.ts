/** Picker families in display order: the existing looks fill the first two, new looks pick one of the rest. */
export const SCENE3D_FAMILIES = [
  "grids",
  "abstract",
  "lines",
  "painted",
  "history",
  "deco",
  "atmosphere",
  "kinetic",
] as const;

export type Scene3dFamily = (typeof SCENE3D_FAMILIES)[number];

/** Heading copy for the grouped 3D picker. */
export const SCENE3D_FAMILY_NAMES: Record<Scene3dFamily, string> = {
  grids: "Grids and fields",
  abstract: "Abstract forms",
  lines: "Lines and engraving",
  painted: "Painted and printed",
  history: "Art history",
  deco: "Deco and architecture",
  atmosphere: "Texture and atmosphere",
  kinetic: "Kinetic",
};

export interface Scene3dFamilyGroup {
  family: Scene3dFamily;
  name: string;
  ids: string[];
}

/** Picker groups in family order, each keeping `ids` order; empty families are left out. */
export function groupScene3dFamilies(
  ids: readonly string[],
  familyOf: (id: string) => Scene3dFamily,
): Scene3dFamilyGroup[] {
  return SCENE3D_FAMILIES.map((family) => ({
    family,
    name: SCENE3D_FAMILY_NAMES[family],
    ids: ids.filter((id) => familyOf(id) === family),
  })).filter((group) => group.ids.length > 0);
}
