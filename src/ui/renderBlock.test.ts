import { describe, expect, it } from "vitest";
import { DEFAULT_MOTION_BLUR } from "../engine/motionBlur";
import { DEFAULT_RENDER_SETTINGS, parseRenderSettings } from "../engine/renderSettings";
import { renderBlockFor } from "./renderBlock";

describe("renderBlockFor", () => {
  it("stores nothing for an untouched default project", () => {
    expect(renderBlockFor(DEFAULT_RENDER_SETTINGS)).toBeUndefined();
    expect(renderBlockFor(parseRenderSettings(undefined, "test"))).toBeUndefined();
    expect(
      renderBlockFor({ ...DEFAULT_RENDER_SETTINGS, motionBlur: { ...DEFAULT_MOTION_BLUR } }),
    ).toBeUndefined();
    expect(renderBlockFor({ ...DEFAULT_RENDER_SETTINGS, textBlur: undefined })).toBeUndefined();
  });

  it("keeps the other keys when ACES returns and optical text blur goes off", () => {
    const loaded = parseRenderSettings(
      {
        toneMapping: "neutral",
        antialias: "smaa",
        supersample: 16,
        textBlur: "optical",
        dither: true,
        specularAA: true,
      },
      "test",
    );
    const aces = { ...loaded, toneMapping: "aces" as const };
    expect(renderBlockFor({ ...aces, textBlur: undefined })).toEqual({
      toneMapping: "aces",
      exposure: 1,
      antialias: "smaa",
      supersample: 16,
      dither: true,
      specularAA: true,
    });
  });

  it("keeps a block that differs from the default by any one key", () => {
    for (const extra of [
      { exposure: 1.5 },
      { toneMapping: "agx" as const },
      { exactText: true as const },
      { antialias: "fxaa" as const },
      { supersample: 4 as const },
      { textBlur: "optical" as const },
      { dither: true as const },
      { specularAA: true as const },
      { motionBlur: { ...DEFAULT_MOTION_BLUR, enabled: !DEFAULT_MOTION_BLUR.enabled } },
    ]) {
      const settings = { ...DEFAULT_RENDER_SETTINGS, ...extra };
      expect(renderBlockFor(settings)).toEqual({ toneMapping: "aces", exposure: 1, ...extra });
    }
  });

  it("round-trips through the parser", () => {
    const settings = parseRenderSettings(
      { toneMapping: "aces", exposure: 1, antialias: "smaa", dither: true },
      "test",
    );
    expect(parseRenderSettings(renderBlockFor(settings), "test")).toEqual(settings);
  });
});
