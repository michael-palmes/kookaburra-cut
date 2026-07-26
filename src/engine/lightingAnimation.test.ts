import { AmbientLight, DirectionalLight, PointLight, Scene } from "three";
import { describe, expect, it } from "vitest";
import { kelvinToHex } from "./kelvin";
import {
  applyFrameLighting,
  lightingAnimatableCount,
  registerLightingAnimatable,
} from "./lightingAnimation";

describe("applyFrameLighting", () => {
  it("writes pose ?? base explicitly per target, so A and B never leak into each other", () => {
    const scene = new Scene();
    const sun = new DirectionalLight("#ffffff", 2);
    const ambient = new AmbientLight("#ffffff", 0.4);
    const rim = new PointLight("#ffffff", 8);
    const cleanups = [
      registerLightingAnimatable("t:sun", {
        kind: "sun",
        sceneIndex: 0,
        light: sun,
        base: { azimuthDeg: 0, elevationDeg: 45, intensity: 2, kelvin: 5000 },
        baseColor: kelvinToHex(5000),
      }),
      registerLightingAnimatable("t:ambient", {
        kind: "ambient",
        sceneIndex: 0,
        light: ambient,
        base: 0.4,
      }),
      registerLightingAnimatable("t:rim", {
        kind: "light",
        sceneIndex: 1,
        id: "rim",
        light: rim,
        base: {
          id: "rim",
          type: "point",
          intensity: 8,
          placement: { mode: "point", position: [2, 2, 2] },
        },
        baseColor: "#ffffff",
      }),
    ];
    try {
      expect(lightingAnimatableCount()).toBe(3);
      // Target A (scene 0): keyed sun + ambient; scene 1's rim untouched.
      applyFrameLighting(scene, {
        index: 0,
        pose: { ambient: 0.1, sun: { intensity: 4, kelvin: 2000 }, environmentIntensity: 0.5 },
      });
      expect(sun.intensity).toBe(4);
      expect(`#${sun.color.getHexString()}`).toBe(kelvinToHex(2000));
      expect(ambient.intensity).toBeCloseTo(0.1, 6);
      expect(scene.environmentIntensity).toBe(0.5);
      expect(rim.intensity).toBe(8);
      // Target B (scene 1): rim keyed; scene 0 handles hold their last-applied values until scene 0's next explicit apply.
      applyFrameLighting(scene, {
        index: 1,
        pose: {
          lights: { rim: { intensity: 2, placement: { mode: "point", position: [0, 5, 0] } } },
        },
      });
      expect(rim.intensity).toBe(2);
      expect(rim.position.toArray()).toEqual([0, 5, 0]);
      // Scene 0 again with an EMPTY pose: everything returns to base explicitly.
      applyFrameLighting(scene, { index: 0, pose: {} });
      expect(sun.intensity).toBe(2);
      expect(`#${sun.color.getHexString()}`).toBe(kelvinToHex(5000));
      expect(ambient.intensity).toBeCloseTo(0.4, 6);
      // No sample: a hard no-op.
      applyFrameLighting(scene, null);
      expect(sun.intensity).toBe(2);
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
    expect(lightingAnimatableCount()).toBe(0);
  });
});
