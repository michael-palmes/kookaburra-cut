import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MOTION_BLUR,
  isDefaultMotionBlur,
  motionBlurAmount,
  parseMotionBlurOverride,
  parseMotionBlurSettings,
  parseSceneMotionBlur,
  resolveSceneMotionBlur,
  snapSamples,
} from "./motionBlur";
import { parseRenderSettings } from "./renderSettings";
import { parseSceneDoc } from "./sceneDocSchema";

afterEach(() => vi.restoreAllMocks());
const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("parseMotionBlurSettings", () => {
  it("keeps absent absent and fills defaults for a bare block", () => {
    expect(parseMotionBlurSettings(undefined, "t")).toBeUndefined();
    expect(parseMotionBlurSettings({ enabled: true }, "t")).toEqual({
      ...DEFAULT_MOTION_BLUR,
      enabled: true,
    });
  });

  it("clamps the shutter, snaps samples and drops bad fields with a warning", () => {
    const warn = quiet();
    expect(
      parseMotionBlurSettings(
        { enabled: true, shutterDeg: 720, samples: 10, camera: "yes", objects: false },
        "t",
      ),
    ).toEqual({ enabled: true, shutterDeg: 360, samples: 8, camera: true, objects: false });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(parseMotionBlurSettings("nope", "t")).toBeUndefined();
  });

  it("rides the render block", () => {
    expect(parseRenderSettings({ toneMapping: "agx" }, "t")).toEqual({
      toneMapping: "agx",
      exposure: 1,
    });
    expect(
      parseRenderSettings({ motionBlur: { enabled: true, samples: 16 } }, "t").motionBlur,
    ).toEqual({ ...DEFAULT_MOTION_BLUR, enabled: true, samples: 16 });
  });
});

describe("snapSamples", () => {
  it("snaps to the nearest allowed count, ties to the cheaper", () => {
    expect(snapSamples(1)).toBe(4);
    expect(snapSamples(6)).toBe(4);
    expect(snapSamples(7)).toBe(8);
    expect(snapSamples(12)).toBe(8);
    expect(snapSamples(64)).toBe(16);
  });
});

describe("isDefaultMotionBlur", () => {
  it("is true only for the off defaults", () => {
    expect(isDefaultMotionBlur(undefined)).toBe(true);
    expect(isDefaultMotionBlur(DEFAULT_MOTION_BLUR)).toBe(true);
    expect(isDefaultMotionBlur({ ...DEFAULT_MOTION_BLUR, shutterDeg: 90 })).toBe(false);
  });
});

describe("parseSceneMotionBlur", () => {
  it("keeps only valid fields and drops an empty block", () => {
    quiet();
    expect(parseSceneMotionBlur({ enabled: true, shutterDeg: 270, objects: false }, "t")).toEqual({
      enabled: true,
      shutterDeg: 270,
      objects: false,
    });
    expect(parseSceneMotionBlur({ camera: 3 }, "t")).toBeUndefined();
    expect(parseSceneMotionBlur([], "t")).toBeUndefined();
  });

  it("survives the sidecar parser", () => {
    const doc = parseSceneDoc({ version: 1, motionBlur: { enabled: false } }, "t");
    expect(doc?.motionBlur).toEqual({ enabled: false });
  });
});

describe("parseMotionBlurOverride", () => {
  it("needs enabled and clamps the amount", () => {
    quiet();
    expect(parseMotionBlurOverride({ enabled: true, amount: 3 }, "t")).toEqual({
      enabled: true,
      amount: 2,
    });
    expect(parseMotionBlurOverride({ enabled: false }, "t")).toEqual({ enabled: false });
    expect(parseMotionBlurOverride({ amount: 1 }, "t")).toBeUndefined();
  });
});

describe("resolveSceneMotionBlur", () => {
  const project = { ...DEFAULT_MOTION_BLUR, enabled: true, shutterDeg: 90 };

  it("is off when nothing enables it", () => {
    expect(resolveSceneMotionBlur(undefined, undefined)).toBeNull();
    expect(resolveSceneMotionBlur(DEFAULT_MOTION_BLUR, {})).toBeNull();
  });

  it("lets each present scene field replace the project's", () => {
    expect(resolveSceneMotionBlur(project, undefined)).toEqual({
      shutterDeg: 90,
      camera: true,
      objects: true,
    });
    expect(resolveSceneMotionBlur(project, { shutterDeg: 360, objects: false })).toEqual({
      shutterDeg: 360,
      camera: true,
      objects: false,
    });
    expect(resolveSceneMotionBlur(project, { enabled: false })).toBeNull();
  });

  it("lets a scene switch blur on while the project is off", () => {
    expect(resolveSceneMotionBlur(undefined, { enabled: true })).toEqual({
      shutterDeg: 180,
      camera: true,
      objects: true,
    });
  });
});

describe("motionBlurAmount", () => {
  it("inherits, pins or scales", () => {
    expect(motionBlurAmount(undefined, 1)).toBe(1);
    expect(motionBlurAmount(undefined, 0)).toBe(0);
    expect(motionBlurAmount({ enabled: false }, 1)).toBe(0);
    expect(motionBlurAmount({ enabled: true }, 0)).toBe(1);
    expect(motionBlurAmount({ enabled: true, amount: 1.5 }, 1)).toBe(1.5);
  });
});
