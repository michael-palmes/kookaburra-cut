import { describe, expect, it } from "vitest";
import { groupScene3dFamilies, SCENE3D_FAMILIES, type Scene3dFamily } from "./families";

describe("groupScene3dFamilies", () => {
  const families: Record<string, Scene3dFamily> = {
    "grid-plain": "grids",
    "orb-field": "abstract",
    "plexus-loom": "kinetic",
    "engraved-hills": "lines",
    "dust-drift": "grids",
    "ink-ranges": "painted",
  };
  const ids = Object.keys(families);
  const groups = groupScene3dFamilies(ids, (id) => families[id]);

  it("heads groups in family order and hides empty families", () => {
    expect(groups.map((g) => g.family)).toEqual([
      "grids",
      "abstract",
      "lines",
      "painted",
      "kinetic",
    ]);
    expect(groups.map((g) => g.name)).toEqual([
      "Grids and fields",
      "Abstract forms",
      "Lines and engraving",
      "Painted and printed",
      "Kinetic",
    ]);
  });

  it("keeps each group's ids in the given order, every id once", () => {
    expect(groups[0].ids).toEqual(["grid-plain", "dust-drift"]);
    expect(groups.flatMap((g) => g.ids).sort()).toEqual([...ids].sort());
  });

  it("returns nothing for no looks and one group per family otherwise", () => {
    expect(groupScene3dFamilies([], () => "grids")).toEqual([]);
    const one = SCENE3D_FAMILIES.map((family) => `look-${family}`);
    expect(
      groupScene3dFamilies(one, (id) => id.slice(5) as Scene3dFamily).map((g) => g.ids),
    ).toEqual(one.map((id) => [id]));
  });
});
