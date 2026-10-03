import { describe, expect, it, vi } from "vitest";
import { placementPosition } from "../../../../engine/orbit";
import { SCENE3D_BACKGROUND_PRESETS } from "../presets";
import type { Scene3dCompanionLighting } from "../types";
import { COMPANION_MAX_LIGHTS, companionLightingProblem, stageSpot } from "./companion";

const rig = (over: Partial<Scene3dCompanionLighting> = {}): Scene3dCompanionLighting => ({
  sun: { azimuthDeg: 25, elevationDeg: 75, intensity: 1.5, kelvin: 3400 },
  ambient: 0.12,
  lights: [
    stageSpot("bg3d-rim", {
      azimuthDeg: 180,
      elevationDeg: -30,
      distance: 9,
      irradiance: 0.5,
      coneDeg: 45,
      color: "#b0905a",
    }),
  ],
  ...over,
});

describe("stageSpot", () => {
  it("sets intensity from the irradiance at the stage (decay 2) and aims from the orbit", () => {
    const s = stageSpot("bg3d-key", {
      azimuthDeg: 0,
      elevationDeg: 90,
      distance: 10,
      irradiance: 0.4,
      coneDeg: 30,
      kelvin: 3000,
    });
    expect(s).toMatchObject({ type: "spot", intensity: 40, angleDeg: 30, kelvin: 3000 });
    expect(s).not.toHaveProperty("color");
    const [x, y, z] = placementPosition(s.placement);
    expect(Math.hypot(x, y, z)).toBeCloseTo(10);
    expect(y).toBeCloseTo(10);
  });
});

describe("companionLightingProblem", () => {
  it("passes a cheap prefixed rig that survives normalizeLighting", () => {
    expect(companionLightingProblem(rig())).toBeNull();
  });

  it("rejects area lights, area-paired fixtures, shadows and unprefixed ids", () => {
    const area = rig({
      lights: [
        {
          id: "bg3d-fill",
          type: "area",
          intensity: 2,
          width: 2,
          height: 1,
          placement: { mode: "point", position: [0, 2, -4] },
        },
      ],
    });
    expect(companionLightingProblem(area)).toMatch(/area light/);
    const tube = rig({
      fixtures: [
        {
          id: "bg3d-tube",
          form: "tube",
          size: [2, 0.05],
          emissive: 2,
          lightIntensity: 3,
          placement: { mode: "point", position: [0, 3, -6] },
        },
      ],
    });
    expect(companionLightingProblem(tube)).toMatch(/pairs an area light/);
    const lights = rig().lights ?? [];
    const shadow = rig({ lights: [{ ...lights[0], castShadow: true }] });
    expect(companionLightingProblem(shadow)).toMatch(/casts shadows/);
    const bare = rig({ lights: [{ ...lights[0], id: "rim" }] });
    expect(companionLightingProblem(bare)).toMatch(/prefix/);
  });

  it("counts lit fixture instances against the cap, decorative ones free", () => {
    const ring = (lightIntensity: number, count: number) =>
      rig({
        fixtures: [
          {
            id: "bg3d-lamps",
            form: "bulb",
            size: [0.3, 0.3],
            emissive: 1.5,
            lightIntensity,
            placement: { mode: "point", position: [0, 3, -8] },
            repeat: { count, spacing: 2, axis: "x" },
          },
        ],
      });
    expect(companionLightingProblem(ring(0, 12))).toBeNull();
    expect(companionLightingProblem(ring(1, COMPANION_MAX_LIGHTS - 1))).toBeNull();
    expect(companionLightingProblem(ring(1, COMPANION_MAX_LIGHTS))).toMatch(/companion cap/);
  });

  it("flags anything normalizeLighting would rewrite", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hot = rig({ sun: { azimuthDeg: 0, elevationDeg: 60, intensity: 1, kelvin: 40000 } });
    expect(companionLightingProblem(hot)).toMatch(/normalizeLighting/);
    warn.mockRestore();
  });

  it("holds for every bundled preset's companion block", () => {
    for (const [look, presets] of Object.entries(SCENE3D_BACKGROUND_PRESETS)) {
      for (const p of presets) {
        if (p.lighting) expect(companionLightingProblem(p.lighting), `${look} ${p.id}`).toBeNull();
      }
    }
  });
});
