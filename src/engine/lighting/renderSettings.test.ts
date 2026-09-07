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
