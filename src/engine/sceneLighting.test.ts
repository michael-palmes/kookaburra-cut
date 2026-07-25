import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LightingSpec } from "../theme/tokens";
import {
  FIXTURE_MAX_COUNT,
  MAX_SCENE_LIGHTS,
  normalizeLighting,
  resolveLighting,
  resolveLightingColour,
  sunShadowSoftness,
} from "./sceneLighting";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const COLORS = { background: "#0b0f14", text: "#f5f7fa", accent: "#3ad1c4", muted: "#8a97a6" };

const validLight = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "l1",
  type: "directional",
  intensity: 1.5,
  placement: { mode: "orbit", azimuthDeg: 45, elevationDeg: 30, distance: 8 },
  ...over,
});

const validFixture = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "f1",
  form: "tube",
  size: [3.2, 0.06],
  emissive: 3.5,
  lightIntensity: 14,
  placement: { mode: "point", position: [0, 2.4, 0] },
  ...over,
});

describe("normalizeLighting", () => {
  it("returns null for a non-object block", () => {
    expect(normalizeLighting("bright", "t")).toBeNull();
    expect(normalizeLighting(null, "t")).toBeNull();
    expect(normalizeLighting([], "t")).toBeNull();
  });

  it("normalises the v8 key alias to sun, verbatim values", () => {
    const spec = normalizeLighting(
      {
        key: { azimuthDeg: -30, elevationDeg: 42, intensity: 1.9, color: "#dbe4ff" },
        ambient: 0.4,
      },
      "t",
    );
    expect(spec?.sun).toEqual({
      azimuthDeg: -30,
      elevationDeg: 42,
      intensity: 1.9,
      color: "#dbe4ff",
    });
    expect(spec?.ambient).toBe(0.4);
  });

  it("sun wins over key when both are present", () => {
    const spec = normalizeLighting(
      {
        sun: { azimuthDeg: 1, elevationDeg: 2, intensity: 3 },
        key: { azimuthDeg: 9, elevationDeg: 9, intensity: 9 },
      },
      "t",
    );
    expect(spec?.sun?.azimuthDeg).toBe(1);
  });

  it("parses the full sun surface with clamps", () => {
    const spec = normalizeLighting(
      {
        sun: {
          azimuthDeg: 35,
          elevationDeg: 40,
          intensity: 1.8,
          kelvin: 50000,
          angularDeg: 200,
          castShadow: false,
          enabled: false,
          colorToken: "accent",
        },
      },
      "t",
    );
    expect(spec?.sun?.kelvin).toBe(20000);
    expect(spec?.sun?.angularDeg).toBe(90);
    expect(spec?.sun?.castShadow).toBe(false);
    expect(spec?.sun?.enabled).toBe(false);
    expect(spec?.sun?.colorToken).toBe("accent");
  });

  it("drops an invalid sun with a warn but keeps the rest", () => {
    const spec = normalizeLighting({ sun: { azimuthDeg: "east" }, ambient: 0.5 }, "t");
    expect(spec?.sun).toBeUndefined();
    expect(spec?.ambient).toBe(0.5);
  });

  it("keeps valid fills, drops invalid ones", () => {
    const spec = normalizeLighting(
      { fills: [{ azimuthDeg: -120, elevationDeg: 15, intensity: 0.7 }, { azimuthDeg: "bad" }] },
      "t",
    );
    expect(spec?.fills).toHaveLength(1);
  });

  it("parses each light type and drops unknown types per entry", () => {
    const spec = normalizeLighting(
      {
        lights: [
          validLight(),
          validLight({ id: "l2", type: "point", distance: 10, decay: 2 }),
          validLight({ id: "l3", type: "spot", angleDeg: 30, penumbra: 0.4 }),
          validLight({ id: "l4", type: "area", width: 2, height: 2 }),
          validLight({ id: "l5", type: "laser" }),
        ],
      },
      "t",
    );
    expect(spec?.lights?.map((l) => l.type)).toEqual(["directional", "point", "spot", "area"]);
  });

  it("requires an id on every light and fixture (keyframes reference them)", () => {
    const spec = normalizeLighting(
      { lights: [validLight({ id: undefined })], fixtures: [validFixture({ id: 42 })] },
      "t",
    );
    expect(spec?.lights).toEqual([]);
    expect(spec?.fixtures).toEqual([]);
  });

  it("dedupes ids keep-first", () => {
    const spec = normalizeLighting(
      { lights: [validLight({ intensity: 1 }), validLight({ intensity: 9 })] },
      "t",
    );
    expect(spec?.lights).toHaveLength(1);
    expect(spec?.lights?.[0].intensity).toBe(1);
  });

  it("clamps spot cone + penumbra and kelvin", () => {
    const spec = normalizeLighting(
      {
        lights: [validLight({ id: "s", type: "spot", angleDeg: 720, penumbra: 4, kelvin: 100 })],
      },
      "t",
    );
    const spot = spec?.lights?.[0];
    expect(spot && "angleDeg" in spot && spot.angleDeg).toBe(179);
    expect(spot && "penumbra" in spot && spot.penumbra).toBe(1);
    expect(spot?.kelvin).toBe(1000);
  });

  it("drops the castShadow flag (not the light) on point and area lights", () => {
    const spec = normalizeLighting(
      {
        lights: [
          validLight({ id: "p", type: "point", castShadow: true }),
          validLight({ id: "a", type: "area", width: 2, height: 1, castShadow: true }),
          validLight({ id: "s", type: "spot", angleDeg: 30, penumbra: 0.5, castShadow: true }),
        ],
      },
      "t",
    );
    expect(spec?.lights?.[0].castShadow).toBeUndefined();
    expect(spec?.lights?.[1].castShadow).toBeUndefined();
    expect(spec?.lights?.[2].castShadow).toBe(true);
  });

  it("drops lights beyond MAX_SCENE_LIGHTS in declaration order", () => {
    const lights = Array.from({ length: MAX_SCENE_LIGHTS + 4 }, (_, i) =>
      validLight({ id: `l${i}` }),
    );
    const spec = normalizeLighting({ lights }, "t");
    expect(spec?.lights).toHaveLength(MAX_SCENE_LIGHTS);
    expect(spec?.lights?.[0].id).toBe("l0");
  });

  it("parses placements in both modes and drops invalid ones", () => {
    const spec = normalizeLighting(
      {
        lights: [
          validLight({ placement: { mode: "point", position: [1, 2, 3] } }),
          validLight({ id: "l2", placement: { mode: "orbit", azimuthDeg: 1 } }),
          validLight({ id: "l3", placement: { mode: "teleport" } }),
        ],
      },
      "t",
    );
    expect(spec?.lights).toHaveLength(1);
    expect(spec?.lights?.[0].placement).toEqual({ mode: "point", position: [1, 2, 3] });
  });

  it("defaults an unknown light space to world (field drop, not entry drop)", () => {
    const spec = normalizeLighting({ lights: [validLight({ space: "screen" })] }, "t");
    expect(spec?.lights?.[0].space).toBeUndefined();
    const ok = normalizeLighting({ lights: [validLight({ space: "camera" })] }, "t");
    expect(ok?.lights?.[0].space).toBe("camera");
  });

  it("parses fixtures with repeat clamps and jitter", () => {
    const spec = normalizeLighting(
      {
        fixtures: [
          validFixture({
            repeat: { count: 500, spacing: 2.4, axis: "z", mirrorAxis: "x", jitter: 3 },
            envMirror: true,
            rotationDeg: [0, 0, 90],
          }),
        ],
      },
      "t",
    );
    const fixture = spec?.fixtures?.[0];
    expect(fixture?.repeat?.count).toBe(FIXTURE_MAX_COUNT);
    expect(fixture?.repeat?.jitter).toBe(1);
    expect(fixture?.repeat?.mirrorAxis).toBe("x");
    expect(fixture?.envMirror).toBe(true);
    expect(fixture?.rotationDeg).toEqual([0, 0, 90]);
  });

  it("drops a fixture with an unknown form or bad size", () => {
    const spec = normalizeLighting(
      {
        fixtures: [
          validFixture({ form: "chandelier" }),
          validFixture({ id: "f2", size: [0, 1] }),
          validFixture({ id: "f3" }),
        ],
      },
      "t",
    );
    expect(spec?.fixtures?.map((f) => f.id)).toEqual(["f3"]);
  });

  it("parses the environment block with defaults, including none", () => {
    const spec = normalizeLighting({ environment: { source: "none" } }, "t");
    expect(spec?.environment).toEqual({ source: "none", intensity: 1, rotationDeg: 0 });
    const bad = normalizeLighting({ environment: { intensity: 2 } }, "t");
    expect(bad?.environment).toBeUndefined();
  });

  it("themeLayer gate: a block with no renderable rig drops whole", () => {
    expect(normalizeLighting({ ambient: 0.5 }, "t", { themeLayer: true })).toBeNull();
    expect(
      normalizeLighting(
        { key: { azimuthDeg: 0, elevationDeg: 0, intensity: 1 }, ambient: 0.5 },
        "t",
        { themeLayer: true },
      ),
    ).not.toBeNull();
    expect(normalizeLighting({ lights: [validLight()] }, "t", { themeLayer: true })).not.toBeNull();
  });

  it("keeps the preset id as an opaque string", () => {
    expect(normalizeLighting({ preset: "neon-corridor" }, "t")?.preset).toBe("neon-corridor");
  });
});

describe("resolveLighting (three layers)", () => {
  const theme: LightingSpec = {
    sun: { azimuthDeg: 35, elevationDeg: 55, intensity: 2 },
    fills: [{ azimuthDeg: -120, elevationDeg: 18, intensity: 0.8 }],
    ambient: 0.85,
  };

  it("returns undefined when every layer is absent (null-for-legacy)", () => {
    expect(resolveLighting(undefined, undefined, undefined)).toBeUndefined();
  });

  it("scene wins over project wins over theme, field-level", () => {
    const merged = resolveLighting(theme, { ambient: 0.3 }, { ambient: 0.1 });
    expect(merged?.ambient).toBe(0.1);
    expect(merged?.sun).toBe(theme.sun);
    expect(resolveLighting(theme, { ambient: 0.3 }, undefined)?.ambient).toBe(0.3);
  });

  it("lists replace wholesale, never merge", () => {
    const sceneLights: LightingSpec = {
      lights: [
        {
          id: "rim",
          type: "area",
          intensity: 6,
          width: 2,
          height: 2,
          placement: { mode: "point", position: [0, 2, 3] },
        },
      ],
    };
    const projectLights: LightingSpec = {
      lights: [
        {
          id: "keyfill",
          type: "point",
          intensity: 8,
          placement: { mode: "point", position: [2, 2, 2] },
        },
      ],
    };
    const merged = resolveLighting(theme, projectLights, sceneLights);
    expect(merged?.lights?.map((l) => l.id)).toEqual(["rim"]);
  });

  it("activates on v9 content without a v8 rig, but not on a partial v8 rig", () => {
    expect(resolveLighting(undefined, undefined, { ambient: 0.4 })).toBeUndefined();
    expect(
      resolveLighting(undefined, undefined, {
        fixtures: [
          {
            id: "f",
            form: "tube",
            size: [3, 0.06],
            emissive: 3,
            lightIntensity: 10,
            placement: { mode: "point", position: [0, 2, 0] },
          },
        ],
      }),
    ).toBeDefined();
  });

  it("is value-identical to the theme alone (the v8 no-op contract)", () => {
    expect(resolveLighting(theme, undefined, undefined)).toEqual(theme);
  });
});

describe("sunShadowSoftness", () => {
  const shadow = { technique: "map" as const, softness: 0.6, opacity: 0.3, mapSize: 2048, bias: 0 };

  it("falls back to the shadow block's raw softness (the v8 path)", () => {
    expect(sunShadowSoftness(undefined, shadow)).toBe(0.6);
    expect(sunShadowSoftness({ azimuthDeg: 0, elevationDeg: 0, intensity: 1 }, shadow)).toBe(0.6);
    expect(sunShadowSoftness(undefined, undefined)).toBe(0.5);
  });

  it("maps angularDeg through SUN_ANGULAR_REFERENCE, clamped (4 degrees = the v8 default 0.5)", () => {
    const sun = { azimuthDeg: 0, elevationDeg: 0, intensity: 1 };
    expect(sunShadowSoftness({ ...sun, angularDeg: 4 }, shadow)).toBe(0.5);
    expect(sunShadowSoftness({ ...sun, angularDeg: 0.53 }, shadow)).toBeCloseTo(0.06625, 6);
    expect(sunShadowSoftness({ ...sun, angularDeg: 90 }, shadow)).toBe(1);
  });
});

describe("resolveLightingColour", () => {
  it("resolves kelvin first, then token, then hex, then white", () => {
    expect(
      resolveLightingColour({ kelvin: 6500, colorToken: "accent", color: "#123456" }, COLORS),
    ).toBe("#fffefa");
    expect(resolveLightingColour({ colorToken: "accent", color: "#123456" }, COLORS)).toBe(
      "#3ad1c4",
    );
    expect(resolveLightingColour({ color: "#123456" }, COLORS)).toBe("#123456");
    expect(resolveLightingColour({}, COLORS)).toBe("#ffffff");
  });

  it("warns and falls through on an unknown token", () => {
    expect(resolveLightingColour({ colorToken: "primary", color: "#123456" }, COLORS)).toBe(
      "#123456",
    );
    expect(resolveLightingColour({ colorToken: "primary" }, COLORS)).toBe("#ffffff");
  });
});
