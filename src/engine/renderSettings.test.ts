import { ToneMappingMode } from "postprocessing";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
} from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composerToneMapping,
  DEFAULT_RENDER_SETTINGS,
  parseRenderSettings,
  threeToneMapping,
} from "./renderSettings";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("parseRenderSettings", () => {
  it("absent or malformed means ACES at 1.0 (the byte-identical default)", () => {
    expect(parseRenderSettings(undefined, "t")).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(parseRenderSettings("cinematic", "t")).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(parseRenderSettings({ toneMapping: "filmic", exposure: "bright" }, "t")).toEqual(
      DEFAULT_RENDER_SETTINGS,
    );
  });

  it("parses the four modes and clamps exposure", () => {
    expect(parseRenderSettings({ toneMapping: "neutral", exposure: 1.5 }, "t")).toEqual({
      toneMapping: "neutral",
      exposure: 1.5,
    });
    expect(parseRenderSettings({ exposure: 100 }, "t").exposure).toBe(4);
    expect(parseRenderSettings({ exposure: 0 }, "t").exposure).toBe(0.25);
  });

  it("carries exactText only when it is true", () => {
    expect(parseRenderSettings({ exactText: true }, "t")).toEqual({
      ...DEFAULT_RENDER_SETTINGS,
      exactText: true,
    });
    for (const exactText of [false, "yes", 1, null]) {
      const parsed = parseRenderSettings({ exactText }, "t");
      expect(parsed).toEqual(DEFAULT_RENDER_SETTINGS);
      expect("exactText" in parsed).toBe(false);
    }
  });

  it("carries textBlur only when it is optical", () => {
    expect(parseRenderSettings({ textBlur: "optical" }, "t")).toEqual({
      ...DEFAULT_RENDER_SETTINGS,
      textBlur: "optical",
    });
    for (const textBlur of ["edge", "gaussian", true, null]) {
      const parsed = parseRenderSettings({ textBlur }, "t");
      expect(parsed).toEqual(DEFAULT_RENDER_SETTINGS);
      expect("textBlur" in parsed).toBe(false);
    }
  });

  it("carries a known supersample count only", () => {
    for (const supersample of [4, 8, 16] as const) {
      expect(parseRenderSettings({ supersample }, "t")).toEqual({
        ...DEFAULT_RENDER_SETTINGS,
        supersample,
      });
    }
    for (const supersample of [2, 1, "4", true, null]) {
      const parsed = parseRenderSettings({ supersample }, "t");
      expect(parsed).toEqual(DEFAULT_RENDER_SETTINGS);
      expect("supersample" in parsed).toBe(false);
    }
  });

  it("carries a known antialias mode only", () => {
    for (const antialias of ["fxaa", "smaa"] as const) {
      expect(parseRenderSettings({ antialias }, "t")).toEqual({
        ...DEFAULT_RENDER_SETTINGS,
        antialias,
      });
    }
    for (const antialias of [true, "msaa", 1, null]) {
      const parsed = parseRenderSettings({ antialias }, "t");
      expect(parsed).toEqual(DEFAULT_RENDER_SETTINGS);
      expect("antialias" in parsed).toBe(false);
    }
  });

  it("carries dither and specularAA only when true", () => {
    for (const key of ["dither", "specularAA"] as const) {
      expect(parseRenderSettings({ [key]: true }, "t")).toEqual({
        ...DEFAULT_RENDER_SETTINGS,
        [key]: true,
      });
      for (const value of [false, "static", 1, null]) {
        const parsed = parseRenderSettings({ [key]: value }, "t");
        expect(parsed).toEqual(DEFAULT_RENDER_SETTINGS);
        expect(key in parsed).toBe(false);
      }
    }
  });
});

describe("mode mapping (the two render paths MUST agree)", () => {
  it("maps one to one across three and postprocessing", () => {
    expect(threeToneMapping("aces")).toBe(ACESFilmicToneMapping);
    expect(threeToneMapping("agx")).toBe(AgXToneMapping);
    expect(threeToneMapping("neutral")).toBe(NeutralToneMapping);
    expect(threeToneMapping("linear")).toBe(LinearToneMapping);
    expect(composerToneMapping("aces")).toBe(ToneMappingMode.ACES_FILMIC);
    expect(composerToneMapping("agx")).toBe(ToneMappingMode.AGX);
    expect(composerToneMapping("neutral")).toBe(ToneMappingMode.NEUTRAL);
    expect(composerToneMapping("linear")).toBe(ToneMappingMode.LINEAR);
  });
});
