import { describe, expect, it } from "vitest";
import type { InspectorState } from "../../store/uiStore";
import { inspectorRouteSignature } from "./InspectorNavigationShell";

function state(drillStack: string[]): InspectorState {
  return {
    tab: "scene",
    drillStack,
    drillIn: drillStack.at(-1) ?? null,
    overviewSelection: null,
  };
}

describe("inspectorRouteSignature", () => {
  it("uses the canonical tab and route path", () => {
    expect(inspectorRouteSignature(state(["lighting", "lighting.light"]))).toBe(
      "scene|lighting/lighting.light",
    );
  });

  it("does not depend on visible user-authored titles", () => {
    const inspector = state(["chart.edit", "chart.series"]);
    expect(inspectorRouteSignature(inspector)).toBe(inspectorRouteSignature({ ...inspector }));
  });
});
