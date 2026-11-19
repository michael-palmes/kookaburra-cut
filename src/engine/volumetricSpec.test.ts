import { describe, expect, it } from "vitest";
import { collectParseWarnings } from "./parseWarnings";
import { normalizeLighting } from "./sceneLighting";
import { parseVolumetric } from "./volumetricSpec";

const FULL = {
  grate: {
    lens: "camera",
    offset: 0.3,
    along: [0.15, 7],
    width: 10,
    slat: [0.01, 0.1],
    gap: [0.01, 0.06],
    wideGap: { p: 0.25, range: [0.08, 0.3] },
    seed: 42,
    bars: [
      [-1, -0.9],
      [0.2, 0.3],
    ],
    soft: 0.012,
  },
  box: { min: [-10, -1.9, -30], max: [10, 7, 3] },
  haze: { density: 0.08, anisotropy: 0.65, strength: 1, heightFalloff: 0, groundFade: 1.5 },
  smoke: {
    scale: 0.4,
    warp: 1.6,
    contrast: [0.47, 0.53],
    floor: 0,
    frontFade: { z0: -2, z1: 2, min: 0.35 },
  },
  extinction: true,
  dust: { count: 1800, color: "#B8A890" },
  shadowMapSize: 2048,
};

describe("parseVolumetric", () => {
  it("keeps a full block and round-trips", () => {
    const once = parseVolumetric(FULL, "t");
    expect(once?.grate?.lens).toBe("camera");
    expect(once?.grate?.bars).toEqual([
      [-1, -0.9],
      [0.2, 0.3],
    ]);
    expect(once?.dust?.color).toBe("#b8a890");
    expect(parseVolumetric(once, "t")).toEqual(once);
  });

  it("clamps numbers and orders pairs", () => {
    const v = parseVolumetric(
      { haze: { density: 99, anisotropy: 2 }, smoke: { contrast: [0.9, 0.1] } },
      "t",
    );
    expect(v?.haze).toEqual({ density: 5, anisotropy: 0.99 });
    expect(v?.smoke?.contrast).toEqual([0.1, 0.9]);
  });

  it("drops malformed pieces but keeps the rest", () => {
    const v = parseVolumetric(
      {
        grate: { lens: "sky", bars: [[0.5, 0.5], "x"] },
        box: { min: [0, 0, 0], max: [1, -1, 1] },
        dust: "lots",
        shadowMapSize: 3000,
        extinction: true,
      },
      "t",
    );
    expect(v).toEqual({ grate: {}, extinction: true });
  });

  it("takes dust: true as the defaults and rejects a non-object", () => {
    expect(parseVolumetric({ dust: true }, "t")).toEqual({ dust: {} });
    expect(parseVolumetric("beam", "t")).toBeUndefined();
  });

  it("needs a box for dust on a camera- or subject-space light, never on a world one", () => {
    const box = { min: [-1, 0, -1], max: [1, 2, 1] };
    const { result, warnings } = collectParseWarnings(() => [
      parseVolumetric({ dust: true }, "t", "camera"),
      parseVolumetric({ dust: { count: 40 }, extinction: true }, "t", "subject"),
    ]);
    expect(result).toEqual([{}, { extinction: true }]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("camera-space light needs a box");
    expect(parseVolumetric({ dust: true, box }, "t", "camera")).toEqual({ box, dust: {} });
    const own = { dust: { min: [-1, 0, -1], max: [1, 2, 1] } };
    expect(parseVolumetric(own, "t", "subject")).toEqual(own);
    expect(parseVolumetric({ dust: true }, "t", "world")).toEqual({ dust: {} });
  });
});

describe("a sidecar spot's volumetric block", () => {
  const lighting = (light: Record<string, unknown>) =>
    normalizeLighting(
      {
        lights: [
          {
            id: "key",
            type: "spot",
            intensity: 520,
            angleDeg: 100,
            penumbra: 0.35,
            placement: { mode: "point", position: [-7, 4.85, -7.6] },
            ...light,
          },
        ],
      },
      "t",
    );

  it("carries through the light parser", () => {
    const spec = lighting({ volumetric: FULL });
    const key = spec?.lights?.[0];
    expect(key?.type === "spot" && key.volumetric?.haze?.groundFade).toBe(1.5);
  });

  it("drops a grate on a camera or subject light", () => {
    const box = { min: [-1, 0, -1], max: [1, 2, 1] };
    const key = lighting({ space: "camera", volumetric: { grate: {}, box, dust: true } })
      ?.lights?.[0];
    expect(key?.type === "spot" && key.volumetric).toEqual({ box, dust: {} });
  });

  it("is absent when not authored", () => {
    const key = lighting({})?.lights?.[0];
    expect(key && "volumetric" in key).toBe(false);
  });
});
