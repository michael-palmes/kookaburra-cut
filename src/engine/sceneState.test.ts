import { Color, Scene, Texture } from "three";
import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import {
  applySceneRenderState,
  buildSceneRenderStates,
  resolveFrameSceneStates,
  usesThemedSceneState,
} from "./sceneState";
import { buildSceneTimeline, resolveAt } from "./sceneTimeline";

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: "test",
    name: "Test",
    colors: { background: "#0b0f14", text: "#ffffff", accent: "#00ffcc", muted: "#888888" },
    typography: {
      headline: { family: "Inter", weight: 400 },
      body: { family: "Inter", weight: 400 },
      scale: 1.25,
    },
    motion: {
      durations: { fast: 200, base: 500, slow: 900 },
      easings: { standard: "outQuad", emphasized: "outExpo" },
    },
    ...overrides,
  };
}

/** Two 1000ms scenes crossfading over 400ms (transition window 600-1000ms global). */
const slots = buildSceneTimeline([
  { id: "a", durationMs: 1000, transition: { type: "crossfade", durationMs: 400 } },
  { id: "b", durationMs: 1000 },
]);

describe("usesThemedSceneState / buildSceneRenderStates (the null-for-legacy gate)", () => {
  it("returns null for a legacy project — every scene sharing a block-free project theme", () => {
    const theme = makeTheme();
    expect(usesThemedSceneState(theme, [theme, theme])).toBe(false);
    expect(buildSceneRenderStates(theme, [theme, theme])).toBeNull();
  });

  it("opts in when any scene swaps the theme", () => {
    const project = makeTheme();
    const other = makeTheme({ id: "other", colors: { ...project.colors, background: "#ffffff" } });
    expect(usesThemedSceneState(project, [project, other])).toBe(true);
    const states = buildSceneRenderStates(project, [project, other]);
    expect(states).toHaveLength(2);
    // Color.set reads the hex as sRGB; pin the round-trip.
    expect(states?.[0].background.getHexString()).toBe("0b0f14");
    expect(states?.[1].background.getHexString()).toBe("ffffff");
    // No theme declares an environment → the shared-env fallback applies at the seam.
    expect(states?.[0].environmentSource).toBeUndefined();
  });

  it("opts in when the project theme itself carries a v8 block", () => {
    const lit = makeTheme({
      lighting: {
        key: { azimuthDeg: 35, elevationDeg: 55, intensity: 2.2 },
        fills: [],
        ambient: 0.5,
      },
    });
    expect(usesThemedSceneState(lit, [lit, lit])).toBe(true);
    const env = makeTheme({
      environment: { source: "kookaburra:softbox", intensity: 1, rotationDeg: 0 },
    });
    expect(usesThemedSceneState(env, [env])).toBe(true);
    const staged = makeTheme({ backdrop: { type: "none" } });
    expect(usesThemedSceneState(staged, [staged])).toBe(true);
  });
});

describe("resolveFrameSceneStates", () => {
  const project = makeTheme();
  const other = makeTheme({ id: "other", colors: { ...project.colors, background: "#ffffff" } });
  const states = buildSceneRenderStates(project, [project, other]);

  it("returns undefined for null states (legacy) regardless of the frame", () => {
    expect(resolveFrameSceneStates(null, resolveAt(slots, 100))).toBeUndefined();
  });

  it("solo frames get the active scene's state", () => {
    const plan = resolveFrameSceneStates(states, resolveAt(slots, 100));
    expect(plan?.solo).toBe(states?.[0]);
    expect(plan?.a).toBeUndefined();
    const late = resolveFrameSceneStates(states, resolveAt(slots, 1400));
    expect(late?.solo).toBe(states?.[1]);
  });

  it("transition frames get per-target states with the DOMINANT scene's overlay", () => {
    // 700ms → progress 0.25 (A dominant); 900ms → progress 0.75 (B dominant).
    const early = resolveFrameSceneStates(states, resolveAt(slots, 700));
    expect(early?.a).toBe(states?.[0]);
    expect(early?.b).toBe(states?.[1]);
    expect(early?.overlay).toBe(states?.[0]);
    const lateTr = resolveFrameSceneStates(states, resolveAt(slots, 900));
    expect(lateTr?.overlay).toBe(states?.[1]);
  });
});

describe("applySceneRenderState", () => {
  const themedTex = new Texture();
  const resolver = (source: string) => (source === "kookaburra:test" ? themedTex : null);

  it("applies a resolved themed environment with intensity + rotation", () => {
    const scene = new Scene();
    applySceneRenderState(
      scene,
      {
        background: new Color("#ffffff"),
        environmentSource: "kookaburra:test",
        environmentIntensity: 0.8,
        environmentRotationDeg: 90,
      },
      { environment: null, intensity: 1, rotationYRad: 0 },
      resolver,
    );
    expect(scene.environment).toBe(themedTex);
    expect(scene.environmentIntensity).toBeCloseTo(0.8);
    expect(scene.environmentRotation.y).toBeCloseTo(Math.PI / 2);
    expect((scene.background as Color).getHexString()).toBe("ffffff");
  });

  it("explicitly applies the shared snapshot when the theme has no environment — never inherits the previous target's", () => {
    const scene = new Scene();
    scene.environment = themedTex; // leftover from the previous (themed) target render
    const sharedTex = new Texture();
    const shared = { environment: sharedTex, intensity: 0.5, rotationYRad: 0.25 };
    applySceneRenderState(scene, { background: new Color("#000000") }, shared, resolver);
    expect(scene.environment).toBe(sharedTex);
    expect(scene.environmentIntensity).toBe(0.5);
    expect(scene.environmentRotation.y).toBe(0.25);
  });

  it("falls back to the shared snapshot while a source is still loading", () => {
    const scene = new Scene();
    const shared = { environment: null, intensity: 1, rotationYRad: 0 };
    applySceneRenderState(
      scene,
      { background: new Color("#000000"), environmentSource: "kookaburra:not-loaded-yet" },
      shared,
      resolver,
    );
    expect(scene.environment).toBeNull();
    expect(scene.environmentIntensity).toBe(1);
  });
});
