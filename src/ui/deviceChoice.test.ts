import { describe, expect, it } from "vitest";
import type { SceneDoc, SceneDocDeviceSpec } from "../engine/sceneDocSchema";
import { applyDeviceChoice } from "./deviceChoice";

describe("device choice persistence", () => {
  it("preserves an unavailable device when an unrelated field changes", () => {
    const original: SceneDoc = {
      version: 1,
      name: "Before",
      devices: [{ id: "hero", model: "iphone-17-pro", colour: "silver" }],
    };
    const next = structuredClone(original);
    next.name = "After";
    const device = next.devices?.[0];
    if (!device) throw new Error("expected a device");

    applyDeviceChoice(device, {
      model: "android",
      colour: "graphite",
      changed: false,
    });

    expect(next.devices?.[0]).toMatchObject({
      model: "iphone-17-pro",
      colour: "silver",
    });
  });

  it("writes Android after the user explicitly selects it", () => {
    const device: SceneDocDeviceSpec = {
      id: "hero",
      model: "iphone-17-pro",
      colour: "silver",
    };

    applyDeviceChoice(device, {
      model: "android",
      colour: "graphite",
      changed: true,
    });

    expect(device).toMatchObject({ model: "android", colour: "graphite" });
  });
});
