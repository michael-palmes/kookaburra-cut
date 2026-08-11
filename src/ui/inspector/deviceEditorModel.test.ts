import { describe, expect, it } from "vitest";
import type { SceneDocDeviceLayout, SceneDocDeviceSpec } from "../../engine/sceneDocSchema";
import {
  changeDeviceModel,
  compatibleDeviceColour,
  replaceDeviceLayoutPreset,
  resetAllDeviceLayoutDeltas,
  resetDeviceLayoutDelta,
} from "./deviceEditorModel";

describe("device editor model", () => {
  it("keeps a finish supported by the new model and preserves every other device field", () => {
    const device: SceneDocDeviceSpec = {
      id: "d1",
      model: "iphone-17-pro",
      colour: "silver",
      media: { src: "assets/demo.mp4", kind: "video", startMs: 120 },
      placement: {
        position: [1, -0.2, 0.4],
        rotationDeg: [3, 12, -2],
        scale: 1.15,
        ground: true,
      },
      motion: { preset: "float", amplitude: 0.2, hz: 0.5 },
      shadow: "long",
      lidDeg: 74,
    };

    expect(changeDeviceModel(device, "macbook-pro-16")).toEqual({
      ...device,
      model: "macbook-pro-16",
    });
    expect(device.model).toBe("iphone-17-pro");
  });

  it("keeps a valid custom finish exactly and defaults only an incompatible finish", () => {
    expect(compatibleDeviceColour("android", "custom:#A1b2C3")).toBe("custom:#A1b2C3");
    expect(compatibleDeviceColour("android", "deep-blue")).toBe("graphite");
    expect(compatibleDeviceColour("android", "custom:#12345g")).toBe("graphite");
    expect(compatibleDeviceColour("iphone-17-pro", undefined)).toBe("silver");
  });

  it("replaces a layout preset while retaining Gap and every device delta", () => {
    const layout: SceneDocDeviceLayout = {
      preset: "row",
      gap: 0.72,
      devices: {
        d1: { offset: [0.2, 0.1, -0.3], scale: 1.2 },
        d2: { rotationDeg: [2, 8, -1] },
      },
    };

    const next = replaceDeviceLayoutPreset(layout, "hero");

    expect(next).toEqual({ ...layout, preset: "hero" });
    expect(next.devices).toBe(layout.devices);
    expect(layout.preset).toBe("row");
  });

  it("creates a layout when choosing the first preset", () => {
    expect(replaceDeviceLayoutPreset(undefined, "toe-in")).toEqual({ preset: "toe-in" });
  });

  it("resets one device delta without changing the remaining layout tuning", () => {
    const layout: SceneDocDeviceLayout = {
      preset: "arc",
      gap: 0.4,
      devices: {
        d1: { offset: [0.3, 0, 0] },
        d2: { scale: 0.9 },
      },
    };

    expect(resetDeviceLayoutDelta(layout, "d1")).toEqual({
      preset: "arc",
      gap: 0.4,
      devices: { d2: { scale: 0.9 } },
    });
    expect(layout.devices).toHaveProperty("d1");
  });

  it("removes an empty delta map after resetting its final device", () => {
    const layout: SceneDocDeviceLayout = {
      preset: "cascade",
      gap: 0.2,
      devices: { d1: { rotationDeg: [0, 10, 0] } },
    };

    expect(resetDeviceLayoutDelta(layout, "d1")).toEqual({
      preset: "cascade",
      gap: 0.2,
    });
    expect(resetDeviceLayoutDelta(layout, "missing")).toBe(layout);
  });

  it("resets every device delta while retaining the preset and Gap", () => {
    const layout: SceneDocDeviceLayout = {
      preset: "depth-pair",
      gap: -0.1,
      devices: {
        d1: { offset: [0, 0, 0.5] },
        d2: { scale: 1.1 },
      },
    };

    expect(resetAllDeviceLayoutDeltas(layout)).toEqual({
      preset: "depth-pair",
      gap: -0.1,
    });
    expect(layout.devices).toHaveProperty("d1");
    expect(resetAllDeviceLayoutDeltas({ preset: "row" })).toEqual({ preset: "row" });
  });
});
