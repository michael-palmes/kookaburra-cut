import { describe, expect, it } from "vitest";
import {
  gizmoDomainForDrill,
  gizmoDomainForDrillStack,
  gizmoDomainForInspector,
} from "./gizmoSections";

describe("gizmoDomainForDrill", () => {
  it("maps every entity editor drill to its domain", () => {
    expect(gizmoDomainForDrill("device")).toBe("devices");
    expect(gizmoDomainForDrill("device.change")).toBe("devices");
    expect(gizmoDomainForDrill("device.position")).toBe("devices");
    expect(gizmoDomainForDrill("image")).toBe("images");
    expect(gizmoDomainForDrill("image.position")).toBe("images");
    expect(gizmoDomainForDrill("legacyImage.edit")).toBe("decorations");
    expect(gizmoDomainForDrill("objects")).toBe("objects");
    expect(gizmoDomainForDrill("objects.placement")).toBe("objects");
    expect(gizmoDomainForDrill("chart.edit")).toBe("chart");
    expect(gizmoDomainForDrill("chart.position")).toBe("chart");
  });

  it("maps the two 2D families to their domains", () => {
    expect(gizmoDomainForDrill("text")).toBe("text");
    expect(gizmoDomainForDrill("text.font:title")).toBe("text");
    expect(gizmoDomainForDrill("frame.decorations")).toBe("decorations");
  });

  it("maps everything else to null", () => {
    for (const id of [
      null,
      undefined,
      "",
      "camera",
      "lighting",
      "frame",
      "frame.text",
      "frame.cutout",
      "textAnimation",
    ]) {
      expect(gizmoDomainForDrill(id)).toBeNull();
    }
  });

  it("matches whole families only, never a prefix that just shares letters", () => {
    expect(gizmoDomainForDrill("devices")).toBeNull();
    expect(gizmoDomainForDrill("images")).toBeNull();
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

describe("gizmoDomainForInspector", () => {
  const inspector = {
    tab: "scene" as const,
    drillStack: [],
    drillIn: null,
    overviewSelection: {
      sceneIndex: 1,
      rowId: "device:phone",
      domain: "devices" as const,
    },
  };

  it("uses the selected overview row domain while the Scene overview is open", () => {
    expect(gizmoDomainForInspector(inspector)).toBe("devices");
  });

  it("lets an open drill family override the retained overview selection", () => {
    expect(
      gizmoDomainForInspector({
        ...inspector,
        drillStack: ["objects", "objects.placement"],
        drillIn: "objects.placement",
      }),
    ).toBe("objects");
    expect(
      gizmoDomainForInspector({
        ...inspector,
        drillStack: ["lighting"],
        drillIn: "lighting",
      }),
    ).toBeNull();
  });

  it("never opens an overview domain on the Project tab", () => {
    expect(gizmoDomainForInspector({ ...inspector, tab: "project" })).toBeNull();
  });
});
