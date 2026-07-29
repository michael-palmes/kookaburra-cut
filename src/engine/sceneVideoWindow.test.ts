import { describe, expect, it } from "vitest";
import type { SceneDocVideoWindow } from "./sceneDocSchema";
import {
  normalizeVideoWindow,
  RECORDING_INSETS,
  RECORDING_RADIUS_PX,
  recordingCrop,
  resolveVideoWindowRadius,
  sampleVideoWindowMotion,
} from "./sceneVideoWindow";

const DEG2RAD = Math.PI / 180;

const minimal = (over: Partial<SceneDocVideoWindow> = {}): SceneDocVideoWindow => ({
  media: { src: "assets/screencast.mp4" },
  radius: "macos",
  ...over,
});

describe("resolveVideoWindowRadius", () => {
  it("maps the named presets to short-edge fractions", () => {
    expect(resolveVideoWindowRadius("sharp")).toBe(0);
    expect(resolveVideoWindowRadius("subtle")).toBeCloseTo(0.02);
    expect(resolveVideoWindowRadius("macos")).toBeCloseTo(0.035);
    expect(resolveVideoWindowRadius("rounded")).toBeCloseTo(0.08);
  });

  it("clamps a custom fraction to 0..0.5", () => {
    expect(resolveVideoWindowRadius({ custom: 0.1 })).toBe(0.1);
    expect(resolveVideoWindowRadius({ custom: 2 })).toBe(0.5);
    expect(resolveVideoWindowRadius({ custom: -1 })).toBe(0);
  });

  it("falls back to the macOS look on anything invalid", () => {
    expect(resolveVideoWindowRadius(undefined)).toBeCloseTo(0.035);
    // biome-ignore lint/suspicious/noExplicitAny: exercising the degrade path
    expect(resolveVideoWindowRadius({ custom: Number.NaN } as any)).toBeCloseTo(0.035);
  });
});

describe("normalizeVideoWindow — degrade + defaults", () => {
  it("is null when absent or missing a media source", () => {
    expect(normalizeVideoWindow(undefined, "s")).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: exercising the degrade path
    expect(normalizeVideoWindow({ media: {} } as any, "s")).toBeNull();
  });

  it("fills defaults for a minimal block", () => {
    const n = normalizeVideoWindow(minimal(), "s");
    expect(n).not.toBeNull();
    expect(n?.media).toEqual({
      src: "assets/screencast.mp4",
      startMs: 0,
      loop: false,
      aspect: null,
    });
    expect(n?.radiusFraction).toBeCloseTo(0.035);
    expect(n?.scale).toBeCloseTo(0.72);
    expect(n?.motion).toEqual({ preset: "none" });
    expect(n?.shadow.opacity).toBeCloseTo(0.32);
    expect(n?.shadow.offset).toEqual([0, -0.05]);
  });

  it("keeps loop only when explicitly true", () => {
    expect(
      normalizeVideoWindow(minimal({ media: { src: "a.mp4", loop: true } }), "s")?.media.loop,
    ).toBe(true);
    expect(normalizeVideoWindow(minimal({ media: { src: "a.mp4" } }), "s")?.media.loop).toBe(false);
  });

  it("clamps scale to 0.1..1", () => {
    expect(normalizeVideoWindow(minimal({ scale: 5 }), "s")?.scale).toBe(1);
    expect(normalizeVideoWindow(minimal({ scale: 0 }), "s")?.scale).toBe(0.1);
    expect(normalizeVideoWindow(minimal({ scale: 0.5 }), "s")?.scale).toBe(0.5);
  });

  it("defaults the placement offset to centred and clamps it", () => {
    expect(normalizeVideoWindow(minimal(), "s")?.offset).toEqual([0, 0]);
    expect(normalizeVideoWindow(minimal({ offset: [0.25, -0.1] }), "s")?.offset).toEqual([
      0.25, -0.1,
    ]);
    expect(normalizeVideoWindow(minimal({ offset: [4, -4] }), "s")?.offset).toEqual([1, -1]);
    // biome-ignore lint/suspicious/noExplicitAny: exercising the degrade path
    expect(normalizeVideoWindow(minimal({ offset: [Number.NaN, 0] as any }), "s")?.offset).toEqual([
      0, 0,
    ]);
  });

  it("flags the recording radius preset and falls back to the macOS fraction", () => {
    const n = normalizeVideoWindow(minimal({ radius: "recording" }), "s");
    expect(n?.recording).toBe(true);
    expect(n?.radiusFraction).toBeCloseTo(0.035);
    expect(normalizeVideoWindow(minimal(), "s")?.recording).toBe(false);
  });

  it("drops an invalid shadow offset back to the default", () => {
    const n = normalizeVideoWindow(
      // biome-ignore lint/suspicious/noExplicitAny: exercising the degrade path
      minimal({ shadow: { opacity: 0.5, blur: 0.2, offset: [1] as any } }),
      "s",
    );
    expect(n?.shadow.opacity).toBe(0.5);
    expect(n?.shadow.blur).toBe(0.2);
    expect(n?.shadow.offset).toEqual([0, -0.05]);
  });

  it("ignores an unknown motion preset", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the degrade path
    const n = normalizeVideoWindow(minimal({ motion: { preset: "spin" } as any }), "s");
    expect(n?.motion).toEqual({ preset: "none" });
  });

  it("fills the border with the legacy hairline default", () => {
    const n = normalizeVideoWindow(minimal(), "s");
    expect(n?.border).toEqual({ enabled: true, color: "#ffffff", width: 0.0035, opacity: 0.12 });
  });

  it("keeps a custom border and honours enabled:false", () => {
    const n = normalizeVideoWindow(
      minimal({ border: { enabled: false, color: "#ff0000", width: 0.01, opacity: 0.8 } }),
      "s",
    );
    expect(n?.border).toEqual({ enabled: false, color: "#ff0000", width: 0.01, opacity: 0.8 });
  });
});

describe("recordingCrop: the raw window recording's margins", () => {
  it("crops the measured capture margins (plus the edge trim) off a 2x recording", () => {
    // The measured example: an 1800x1122 capture holding a 1576x898 window, trimmed 2px a side.
    const crop = recordingCrop(1800, 1122);
    expect(crop).toEqual({
      x: RECORDING_INSETS.left + 2,
      y: RECORDING_INSETS.top + 2,
      width: 1572,
      height: 894,
      radiusFraction: RECORDING_RADIUS_PX / 894,
    });
  });

  it("is null when the clip cannot carry the margins", () => {
    expect(recordingCrop(200, 200)).toBeNull();
    expect(recordingCrop(1800, 220)).toBeNull();
  });

  it("takes the radius fraction off the cropped short edge", () => {
    const wide = recordingCrop(4000, 1122);
    expect(wide?.radiusFraction).toBeCloseTo(RECORDING_RADIUS_PX / 894);
    const tall = recordingCrop(1000, 4000);
    expect(tall?.radiusFraction).toBeCloseTo(RECORDING_RADIUS_PX / (1000 - 228));
  });
});

describe("sampleVideoWindowMotion — pure, clock-driven", () => {
  it("none is the identity transform", () => {
    expect(sampleVideoWindowMotion({ preset: "none" }, 1234)).toEqual({
      posX: 0,
      posY: 0,
      posZ: 0,
      rotX: 0,
      rotY: 0,
      scale: 1,
    });
  });

  it("float bobs symmetrically from zero", () => {
    expect(sampleVideoWindowMotion({ preset: "float" }, 0).posY).toBeCloseTo(0);
    // amplitude 0.12, hz 0.3 → peak at a quarter period (1/(4·0.3) s ≈ 833ms)
    expect(sampleVideoWindowMotion({ preset: "float" }, 1000 / (4 * 0.3)).posY).toBeCloseTo(0.12);
  });

  it("tilt-reveal eases from tilted to rest and rides forward so it clears the stage", () => {
    const start = sampleVideoWindowMotion({ preset: "tilt-reveal" }, 0);
    expect(start.rotX).toBeCloseTo(-12 * DEG2RAD);
    expect(start.rotY).toBeCloseTo(-28 * DEG2RAD);
    expect(start.posZ).toBeGreaterThan(0); // starts toward the camera
    const rest = sampleVideoWindowMotion({ preset: "tilt-reveal" }, 5000);
    expect(rest.rotX).toBeCloseTo(0);
    expect(rest.rotY).toBeCloseTo(0);
    expect(rest.posZ).toBeCloseTo(0); // eases back flush
    expect(rest.scale).toBeCloseTo(1);
  });

  it("push-in eases scale from 0.9 to 1", () => {
    expect(sampleVideoWindowMotion({ preset: "push-in" }, 0).scale).toBeCloseTo(0.9);
    expect(sampleVideoWindowMotion({ preset: "push-in" }, 5000).scale).toBeCloseTo(1);
  });

  it("is a pure function of localMs (same input, same output)", () => {
    const a = sampleVideoWindowMotion({ preset: "drift" }, 4321);
    const b = sampleVideoWindowMotion({ preset: "drift" }, 4321);
    expect(a).toEqual(b);
  });
});
