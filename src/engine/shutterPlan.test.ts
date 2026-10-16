import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MOTION_BLUR } from "./motionBlur";
import { normalizeSceneCamera, resolveFrameCameras, sceneCameraTracks } from "./sceneCamera";
import type { SceneDoc, SceneDocCameraPose } from "./sceneDocSchema";
import { resolveAt, type SceneSlot } from "./sceneTimeline";
import { sampleShutterDeg } from "./shutter";
import { buildShutterPlan, frameCameraShutter } from "./shutterPlan";

afterEach(() => vi.restoreAllMocks());

const pose = (azimuthDeg: number, shutterDeg?: number): SceneDocCameraPose => ({
  target: [0, 0, 0],
  azimuthDeg,
  elevationDeg: 0,
  distance: 5,
  ...(shutterDeg === undefined ? {} : { shutterDeg }),
});

const slot = (index: number, startMs: number, durationMs: number): SceneSlot => ({
  index,
  id: `s${index}`,
  startMs,
  endMs: startMs + durationMs,
  durationMs,
});

const orbit = (keys: { tMs: number; pose: SceneDocCameraPose }[], ease = "linear") => {
  const ids = keys.map((_, i) => `k${i}`);
  return sceneCameraTracks(
    normalizeSceneCamera(
      {
        keys: keys.map((k, i) => ({ id: ids[i], ...k })),
        segments: ids.slice(1).map((to, i) => ({ from: ids[i], to, ease })),
      },
      "test",
    ),
    null,
  );
};

const on = { ...DEFAULT_MOTION_BLUR, enabled: true };

describe("sampleShutterDeg", () => {
  it("inherits the scene angle, mixes keyed ones and holds outside segments", () => {
    const tracks = orbit([
      { tMs: 0, pose: pose(0) },
      { tMs: 1000, pose: pose(30, 360) },
    ]);
    expect(sampleShutterDeg(tracks, 0, 180)).toBe(180);
    expect(sampleShutterDeg(tracks, 500, 180)).toBe(270);
    expect(sampleShutterDeg(tracks, 1500, 180)).toBe(360);
    expect(sampleShutterDeg(null, 500, 90)).toBe(90);
  });
});

describe("buildShutterPlan", () => {
  it("is null when no scene blurs", () => {
    const slots = [slot(0, 0, 1000)];
    expect(buildShutterPlan({ fps: 60, slots, sceneDocs: [], motionBlur: undefined })).toBeNull();
    expect(
      buildShutterPlan({
        fps: 60,
        slots,
        sceneDocs: [{ version: 1, motionBlur: { enabled: false } } as SceneDoc],
        motionBlur: on,
      }),
    ).toBeNull();
  });

  it("resolves per scene and takes the project's sample count", () => {
    const plan = buildShutterPlan({
      fps: 60,
      slots: [slot(0, 0, 1000), slot(1, 1000, 1000)],
      sceneDocs: [undefined, { version: 1, motionBlur: { enabled: true } } as SceneDoc],
      motionBlur: { ...DEFAULT_MOTION_BLUR, samples: 4 },
    });
    expect(plan?.units).toHaveLength(4);
    expect(plan?.scenes[0]).toBeNull();
    expect(plan?.scenes[1]?.blur.shutterDeg).toBe(180);
  });
});

describe("frameCameraShutter", () => {
  const slots = [slot(0, 0, 2000)];
  const moving = orbit([
    { tMs: 0, pose: pose(0) },
    { tMs: 1000, pose: pose(60) },
  ]);
  const plan = buildShutterPlan({
    fps: 60,
    slots,
    sceneDocs: [],
    motionBlur: on,
  });
  if (!plan) throw new Error("plan expected");
  const at = (tMs: number) => {
    const resolved = resolveAt(slots, tMs);
    const centre = resolveFrameCameras([moving], undefined, resolved, tMs);
    return frameCameraShutter(plan, resolved, tMs, [moving], undefined, centre);
  };

  it("samples a moving camera across the shutter", () => {
    const frame = at(500);
    expect(frame?.plans).toHaveLength(8);
    const xs = frame?.plans.map((p) => p?.solo?.position[0] ?? 0) ?? [];
    expect(new Set(xs).size).toBe(8);
  });

  it("takes a sample count override", () => {
    const resolved = resolveAt(slots, 500);
    const centre = resolveFrameCameras([moving], undefined, resolved, 500);
    expect(
      frameCameraShutter(plan, resolved, 500, [moving], undefined, centre, 4)?.plans,
    ).toHaveLength(4);
  });

  it("is null while the camera holds", () => {
    expect(at(1500)).toBeNull();
  });

  it("is null when the scene's camera blur is off", () => {
    const off = buildShutterPlan({
      fps: 60,
      slots,
      sceneDocs: [{ version: 1, motionBlur: { camera: false } } as SceneDoc],
      motionBlur: on,
    });
    if (!off) throw new Error("plan expected");
    const resolved = resolveAt(slots, 500);
    expect(frameCameraShutter(off, resolved, 500, [moving], undefined, null)).toBeNull();
  });

  it("never samples across a jump cut", () => {
    const cut = orbit(
      [
        { tMs: 0, pose: pose(0) },
        { tMs: 1000, pose: pose(90) },
        { tMs: 2000, pose: pose(120) },
      ],
      "jump",
    );
    const cutPlan = buildShutterPlan({
      fps: 60,
      slots,
      sceneDocs: [],
      motionBlur: { ...on, shutterDeg: 360 },
    });
    if (!cutPlan) throw new Error("plan expected");
    // Just before the cut: every sample stays on the pre-cut pose, so the camera holds.
    const resolved = resolveAt(slots, 995);
    const centre = resolveFrameCameras([cut], undefined, resolved, 995);
    expect(frameCameraShutter(cutPlan, resolved, 995, [cut], undefined, centre)).toBeNull();
    // Just after it: no sample reaches back to the pre-cut pose.
    const after = resolveAt(slots, 1003);
    const afterCentre = resolveFrameCameras([cut], undefined, after, 1003);
    expect(frameCameraShutter(cutPlan, after, 1003, [cut], undefined, afterCentre)).toBeNull();
  });
});
