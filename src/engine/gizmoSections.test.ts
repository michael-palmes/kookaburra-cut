import { describe, expect, it } from "vitest";
import { gizmoDomainForDrill, gizmoDomainForDrillStack } from "./gizmoSections";

describe("gizmoDomainForDrill", () => {
  it("maps every device, objects and chart drill to its domain", () => {
    expect(gizmoDomainForDrill("device")).toBe("devices");
    expect(gizmoDomainForDrill("device.change")).toBe("devices");
    expect(gizmoDomainForDrill("device.position")).toBe("devices");
    expect(gizmoDomainForDrill("objects")).toBe("objects");
    expect(gizmoDomainForDrill("objects.placement")).toBe("objects");
    expect(gizmoDomainForDrill("chart.edit")).toBe("chart");
    expect(gizmoDomainForDrill("chart.position")).toBe("chart");
  });

  it("maps everything else to null", () => {
    for (const id of [null, undefined, "", "text", "frame.decorations", "camera", "lighting"]) {
      expect(gizmoDomainForDrill(id)).toBeNull();
    }
  });

  it("matches whole families only, never a prefix that just shares letters", () => {
    expect(gizmoDomainForDrill("devices")).toBeNull();
    expect(gizmoDomainForDrill("charting")).toBeNull();
  });
});

describe("gizmoDomainForDrillStack", () => {
  it("is null for an empty stack and for an all-unmapped one", () => {
    expect(gizmoDomainForDrillStack([])).toBeNull();
    expect(gizmoDomainForDrillStack(["style.theme", "camera"])).toBeNull();
  });

  it("reads a section through a drill that carries another family's id", () => {
    expect(gizmoDomainForDrillStack(["device"])).toBe("devices");
    expect(gizmoDomainForDrillStack(["device", "style.shadow"])).toBe("devices");
  });

  it("takes the deepest match when a stack crosses families", () => {
    expect(gizmoDomainForDrillStack(["objects", "objects.placement"])).toBe("objects");
    expect(gizmoDomainForDrillStack(["device", "chart.edit"])).toBe("chart");
  });
});
