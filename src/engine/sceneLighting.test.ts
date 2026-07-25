import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LightingSpec, LightSpec, Placement } from "../theme/tokens";
import {
  buildLightingTracks,
  captureLightingPose,
  chainLightingSegments,
  FIXTURE_MAX_COUNT,
  MAX_SCENE_LIGHTS,
  mixPlacement,
  normalizeLighting,
  normalizeLightingTrack,
  resolveFrameLighting,
  resolveLightBudget,
  resolveLighting,
  resolveLightingColour,
  sampleLightingPose,
  spotHalfAngleRad,
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

describe("spotHalfAngleRad", () => {
  it("converts the artist's full cone to three's radian half-angle", () => {
    expect(spotHalfAngleRad(30)).toBeCloseTo((15 * Math.PI) / 180, 10);
    expect(spotHalfAngleRad(90)).toBeCloseTo(Math.PI / 4, 10);
    expect(spotHalfAngleRad(179)).toBeCloseTo((89.5 * Math.PI) / 180, 10);
  });
});

describe("resolveLightBudget", () => {
  const orbit = { mode: "orbit", azimuthDeg: 0, elevationDeg: 0, distance: 5 } as const;
  const dir = (id: string, castShadow?: boolean): LightSpec => ({
    id,
    type: "directional",
    intensity: 1,
    placement: orbit,
    ...(castShadow ? { castShadow: true } : {}),
  });

  it("drops disabled lights and caps the list below MAX_SCENE_LIGHTS with the sun's slot", () => {
    const lights = Array.from({ length: MAX_SCENE_LIGHTS }, (_, i) => dir(`l${i}`));
    const spec: LightingSpec = {
      sun: { azimuthDeg: 0, elevationDeg: 0, intensity: 1 },
      lights: [{ ...dir("off"), enabled: false }, ...lights],
    };
    const budget = resolveLightBudget(spec, false);
    expect(budget.lights).toHaveLength(MAX_SCENE_LIGHTS - 1);
    expect(budget.lights.some((l) => l.id === "off")).toBe(false);
    expect(budget.droppedLights).toBe(1);
  });

  it("gives casters to the first MAX_SHADOW_CASTERS in declaration order, sun first", () => {
    const spec: LightingSpec = {
      lights: [dir("a", true), dir("b", true), dir("c", true), dir("d", true), dir("e", true)],
    };
    const withSun = resolveLightBudget(spec, true);
    expect([...withSun.shadowCasterIds]).toEqual(["a", "b", "c"]);
    expect(withSun.droppedCasters).toBe(2);
    const withoutSun = resolveLightBudget(spec, false);
    expect([...withoutSun.shadowCasterIds]).toEqual(["a", "b", "c", "d"]);
    expect(withoutSun.droppedCasters).toBe(1);
  });

  it("never gives a caster slot to point or area lights", () => {
    const spec: LightingSpec = {
      lights: [
        {
          id: "p",
          type: "point",
          intensity: 1,
          placement: orbit,
          castShadow: true,
        } as LightSpec,
        dir("d", true),
      ],
    };
    expect([...resolveLightBudget(spec, false).shadowCasterIds]).toEqual(["d"]);
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

describe("lighting keyframes (v9 · PR 6)", () => {
  const specWithTrack = (keys: unknown, segments?: unknown): LightingSpec =>
    ({
      sun: { azimuthDeg: 0, elevationDeg: 45, intensity: 2 },
      ambient: 0.4,
      lights: [
        {
          id: "rim",
          type: "directional",
          intensity: 1,
          placement: { mode: "orbit", azimuthDeg: 0, elevationDeg: 0, distance: 5 },
        },
      ],
      keys,
      segments,
    }) as LightingSpec;

  it("normalises a track, dropping bad keys and unknown-id pose entries", () => {
    const track = normalizeLightingTrack(
      specWithTrack(
        [
          {
            id: "k1",
            tMs: 0,
            pose: { ambient: 0.1, lights: { rim: { intensity: 2 }, ghost: { intensity: 9 } } },
          },
          { id: "k1", tMs: 500, pose: {} },
          { id: "k2", tMs: "soon", pose: {} },
          { id: "k3", tMs: 1000, pose: { sun: { intensity: 4 } } },
        ],
        [
          { from: "k1", to: "k3", ease: "inOutSine" },
          { from: "k3", to: "missing", ease: "linear" },
        ],
      ),
      "t",
    );
    expect(track?.keys.map((k) => k.id)).toEqual(["k1", "k3"]);
    expect(track?.keys[0].pose.lights?.rim).toEqual({ intensity: 2 });
    expect(track?.keys[0].pose.lights?.ghost).toBeUndefined();
    expect(track?.segments).toHaveLength(1);
    expect(normalizeLightingTrack(specWithTrack([]), "t")).toBeNull();
  });

  it("samples eased interpolation inside a segment and holds outside", () => {
    const track = normalizeLightingTrack(
      specWithTrack(
        [
          { id: "k1", tMs: 0, pose: { ambient: 0, sun: { intensity: 2, kelvin: 2000 } } },
          { id: "k2", tMs: 1000, pose: { ambient: 1, sun: { intensity: 4, kelvin: 6000 } } },
        ],
        [{ from: "k1", to: "k2", ease: "linear" }],
      ),
      "t",
    );
    if (!track) throw new Error("track expected");
    const mid = sampleLightingPose(track, 500);
    expect(mid.ambient).toBeCloseTo(0.5, 6);
    expect(mid.sun?.intensity).toBeCloseTo(3, 6);
    // Kelvin interpolates in KELVIN space, not RGB.
    expect(mid.sun?.kelvin).toBeCloseTo(4000, 6);
    expect(sampleLightingPose(track, 2000).ambient).toBe(1);
    expect(sampleLightingPose(track, -50).ambient).toBe(0);
  });

  it("a field present at only one endpoint holds rather than lerping to nothing", () => {
    const track = normalizeLightingTrack(
      specWithTrack(
        [
          { id: "k1", tMs: 0, pose: { ambient: 0.2, sun: { intensity: 3 } } },
          { id: "k2", tMs: 1000, pose: { ambient: 0.8 } },
        ],
        [{ from: "k1", to: "k2", ease: "linear" }],
      ),
      "t",
    );
    if (!track) throw new Error("track expected");
    const mid = sampleLightingPose(track, 500);
    expect(mid.ambient).toBeCloseTo(0.5, 6);
    expect(mid.sun?.intensity).toBe(3);
  });

  it("mixPlacement stays in orbit space for orbit pairs and normalises mixed pairs to point", () => {
    const a = { mode: "orbit", azimuthDeg: 0, elevationDeg: 0, distance: 4 } as const;
    const b = { mode: "orbit", azimuthDeg: 90, elevationDeg: 0, distance: 8 } as const;
    const mid = mixPlacement(a, b, 0.5);
    expect(mid).toEqual({ mode: "orbit", azimuthDeg: 45, elevationDeg: 0, distance: 6 });
    const point: Placement = { mode: "point", position: [4, 0, 0] };
    const mixed = mixPlacement(a, point, 0.5);
    expect(mixed.mode).toBe("point");
    if (mixed.mode === "point") {
      expect(mixed.position[0]).toBeCloseTo(2, 6);
      expect(mixed.position[2]).toBeCloseTo(2, 6);
    }
  });

  it("resolveFrameLighting samples A and B at their OWN scene-local times (the transition trap)", () => {
    const theme = {
      colors: COLORS,
      lighting: { sun: { azimuthDeg: 0, elevationDeg: 45, intensity: 2 }, ambient: 0.4 },
    } as unknown as Parameters<typeof buildLightingTracks>[0][number];
    const docA = {
      lighting: specWithTrack(
        [
          { id: "k1", tMs: 0, pose: { ambient: 0 } },
          { id: "k2", tMs: 1000, pose: { ambient: 1 } },
        ],
        [{ from: "k1", to: "k2", ease: "linear" }],
      ),
    };
    const docB = {
      lighting: specWithTrack(
        [
          { id: "k1", tMs: 0, pose: { ambient: 1 } },
          { id: "k2", tMs: 1000, pose: { ambient: 0 } },
        ],
        [{ from: "k1", to: "k2", ease: "linear" }],
      ),
    };
    const tracks = buildLightingTracks([theme, theme], undefined, [docA, docB]);
    const plan = resolveFrameLighting(tracks, {
      active: [
        { index: 0, localMs: 750 },
        { index: 1, localMs: 250 },
      ],
      transition: { fromIndex: 0, toIndex: 1, progress: 0.4 },
    });
    expect(plan?.a?.pose.ambient).toBeCloseTo(0.75, 6);
    expect(plan?.b?.pose.ambient).toBeCloseTo(0.75, 6);
    expect(plan?.overlay).toBe(plan?.a);
    expect(resolveFrameLighting([null, null], { active: [{ index: 0, localMs: 0 }] })).toBeNull();
  });

  it("captureLightingPose diffs the scene layer against the theme+project base", () => {
    const theme = {
      colors: COLORS,
      lighting: { sun: { azimuthDeg: 0, elevationDeg: 45, intensity: 2 }, ambient: 0.4 },
    } as unknown as Parameters<typeof captureLightingPose>[0];
    const pose = captureLightingPose(theme, undefined, {
      sun: { azimuthDeg: 0, elevationDeg: 45, intensity: 3.5, kelvin: 2900 },
      ambient: 0.4,
    });
    expect(pose.sun).toEqual({ intensity: 3.5, kelvin: 2900 });
    expect(pose.ambient).toBeUndefined();
    expect(captureLightingPose(theme, undefined, undefined)).toEqual({});
  });

  it("chainLightingSegments chains consecutive keys and preserves matching eases", () => {
    const keys = [
      { id: "k2", tMs: 1000, pose: {} },
      { id: "k1", tMs: 0, pose: {} },
      { id: "k3", tMs: 2000, pose: {} },
    ];
    const segments = chainLightingSegments(keys, [{ from: "k1", to: "k2", ease: "outExpo" }]);
    expect(segments).toEqual([
      { from: "k1", to: "k2", ease: "outExpo" },
      { from: "k2", to: "k3", ease: "inOutSine" },
    ]);
  });
});
