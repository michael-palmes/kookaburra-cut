import { describe, expect, it } from "vitest";
import { lightingHelpersVisibleForRoute } from "./LightHelpers";

describe("lighting helper visibility", () => {
  it("keeps helpers mounted across every Lighting inspector screen", () => {
    expect(lightingHelpersVisibleForRoute("lighting")).toBe(true);
    expect(lightingHelpersVisibleForRoute("lighting.environment")).toBe(true);
    expect(lightingHelpersVisibleForRoute("lighting.sun")).toBe(true);
    expect(lightingHelpersVisibleForRoute("lighting.fixtures")).toBe(true);
    expect(lightingHelpersVisibleForRoute("lighting.shadows")).toBe(true);
    expect(lightingHelpersVisibleForRoute("lighting.animation")).toBe(true);
  });

  it("hides helpers outside the Lighting inspector family", () => {
    expect(lightingHelpersVisibleForRoute("camera")).toBe(false);
    expect(lightingHelpersVisibleForRoute("lighting-preview")).toBe(false);
    expect(lightingHelpersVisibleForRoute(null)).toBe(false);
  });
});
