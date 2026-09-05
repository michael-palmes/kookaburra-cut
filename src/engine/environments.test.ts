import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import {
  BUNDLED_ENVIRONMENT_IDS,
  collectEnvironmentSources,
  environmentCacheKey,
  resolveSceneEnvironment,
} from "./environments";
import { setProjectAssetRevision } from "./projectAssetRevision";

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

describe("environmentCacheKey", () => {
  it("rebuilds user HDR reflections for each hidden poster source revision", () => {
    const projectId = "ws-preset:hdr-poster";
    setProjectAssetRevision(projectId, "first");
    const first = environmentCacheKey(projectId, "assets/studio.hdr");
    setProjectAssetRevision(projectId, "second");
    expect(environmentCacheKey(projectId, "assets/studio.hdr")).not.toBe(first);
    expect(environmentCacheKey(projectId, "kookaburra:warehouse")).toBe("kookaburra:warehouse");
  });
  it("passes bundled ids and none through, keys user paths per project", () => {
    expect(environmentCacheKey("ws:a", "kookaburra:warehouse")).toBe("kookaburra:warehouse");
    expect(environmentCacheKey("ws:a", "none")).toBe("none");
    expect(environmentCacheKey("ws:a", "assets/studio.hdr")).toBe("ws:a|assets/studio.hdr");
    expect(environmentCacheKey("ws:b", "assets/studio.hdr")).toBe("ws:b|assets/studio.hdr");
  });
});

describe("resolveSceneEnvironment", () => {
  const env = (source: string) => ({ source, intensity: 1, rotationDeg: 0 });

  it("resolves scene doc over project over the theme's lighting block over the v8 theme block", () => {
    const theme = makeTheme({
      environment: env("kookaburra:ferndale-studio"),
      lighting: {
        sun: { azimuthDeg: 0, elevationDeg: 0, intensity: 1 },
        ambient: 0.4,
        environment: env("kookaburra:sunset"),
      },
    });
    expect(resolveSceneEnvironment(theme, undefined, undefined)?.source).toBe("kookaburra:sunset");
    expect(
      resolveSceneEnvironment(theme, { environment: env("kookaburra:dawn") }, undefined)?.source,
    ).toBe("kookaburra:dawn");
    expect(
      resolveSceneEnvironment(
        theme,
        { environment: env("kookaburra:dawn") },
        { version: 1, lighting: { environment: env("none") } },
      )?.source,
    ).toBe("none");
    const v8Only = makeTheme({ environment: env("kookaburra:ferndale-studio") });
    expect(resolveSceneEnvironment(v8Only, undefined, undefined)?.source).toBe(
      "kookaburra:ferndale-studio",
    );
    expect(resolveSceneEnvironment(makeTheme(), undefined, undefined)).toBeUndefined();
  });
});

describe("collectEnvironmentSources", () => {
  it("collects across every layer, dedupes, and excludes none", () => {
    const theme = makeTheme({
      environment: { source: "kookaburra:ferndale-studio", intensity: 1, rotationDeg: 0 },
    });
    const sources = collectEnvironmentSources(
      "ws:spike",
      [theme, theme],
      { environment: { source: "assets/studio.hdr", intensity: 1, rotationDeg: 0 } },
      [
        { version: 1, lighting: { environment: { source: "none", intensity: 1, rotationDeg: 0 } } },
        {
          version: 1,
          lighting: {
            environment: { source: "kookaburra:warehouse", intensity: 0.35, rotationDeg: 0 },
          },
        },
      ],
    );
    expect(sources).toContain("kookaburra:ferndale-studio");
    expect(sources).toContain("kookaburra:warehouse");
    expect(sources).toContain("ws:spike|assets/studio.hdr");
    expect(sources).not.toContain("none");
    expect(sources).toHaveLength(3);
  });
});

describe("bundled environment ids", () => {
  it("ships the nine curated maps in picker order", () => {
    expect(BUNDLED_ENVIRONMENT_IDS).toEqual([
      "kookaburra:ferndale-studio",
      "kookaburra:monochrome-studio",
      "kookaburra:story-studio",
      "kookaburra:warehouse",
      "kookaburra:night-city",
      "kookaburra:sunset",
      "kookaburra:cyclorama",
      "kookaburra:dawn",
      "kookaburra:interior",
    ]);
  });
});
