import { describe, expect, it } from "vitest";
import type { InspectorState } from "../../store/uiStore";
import { chartSeriesInspectorRoute } from "../inspectorTitles";
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

  it("uses the stable chart child route rather than its visible authored title", () => {
    const route = chartSeriesInspectorRoute("revenue/APAC");
    const inspector = state(["chart.edit", route]);

    expect(inspectorRouteSignature(inspector)).toBe(`scene|chart.edit/${route}`);
    expect(inspectorRouteSignature(inspector)).toBe(inspectorRouteSignature({ ...inspector }));
  });
});
