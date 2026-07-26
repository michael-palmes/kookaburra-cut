import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAMERA_PRESETS, presetContext, spreadTimes } from "./cameraPresets";
import { MIN_KEY_GAP_MS } from "./keyedTrack";
import { normalizeSceneCamera } from "./sceneCamera";
import type { SceneDocCameraPose } from "./sceneDocSchema";
import { normalizeSceneRig, RIG_FOV_MAX, RIG_FOV_MIN, sampleSceneRig } from "./sceneRig";

const orbit: SceneDocCameraPose = {
  target: [0, -0.2, 0],
  azimuthDeg: 12,
  elevationDeg: 6,
  distance: 5,
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("spreadTimes", () => {
  it("spans the scene, ascending", () => {
    expect(spreadTimes(1200, 3)).toEqual([0, 600, 1200]);
  });

  it("never packs keys closer than the engine's minimum gap", () => {
    const times = spreadTimes(10, 4);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(MIN_KEY_GAP_MS);
    }
  });
});

describe("every preset", () => {
  const durations = [4000, 900, 20];

  for (const preset of CAMERA_PRESETS) {
    describe(preset.label, () => {
      for (const durationMs of durations) {
        it(`normalises unchanged at ${durationMs}ms`, () => {
          const built = preset.build(presetContext(durationMs, orbit, 45));
          expect(built.mode).toBe(preset.mode);
          if (built.mode === "orbit") {
            const track = normalizeSceneCamera(built.camera, "preset");
            expect(track?.keys).toHaveLength(built.camera?.keys.length ?? 0);
            expect(track?.segments).toHaveLength(built.camera?.segments.length ?? 0);
          } else {
            const track = normalizeSceneRig(built.rig, "preset");
            expect(track?.keys).toHaveLength(built.rig?.keys.length ?? 0);
            expect(track?.segments).toHaveLength(built.rig?.segments.length ?? 0);
          }
        });
      }

      it("keeps any authored fov inside the clamp, so normalising never rewrites it", () => {
        const built = preset.build(presetContext(3000, orbit, 45));
        for (const key of built.rig?.keys ?? []) {
          if (key.pose.fov === undefined) continue;
          expect(key.pose.fov).toBeGreaterThanOrEqual(RIG_FOV_MIN);
          expect(key.pose.fov).toBeLessThanOrEqual(RIG_FOV_MAX);
        }
      });
    });
  }
});

describe("preset behaviour", () => {
  const ctx = presetContext(2000, orbit, 45);
  const byId = (id: string) => {
    const preset = CAMERA_PRESETS.find((p) => p.id === id);
    if (!preset) throw new Error(`no preset ${id}`);
    return preset.build(ctx);
  };

  it("push in seeds from the CURRENT distance rather than a fixed one", () => {
    const near = presetContext(2000, { ...orbit, distance: 9 }, 45);
    const built = CAMERA_PRESETS[0].build(near);
    expect(built.camera?.keys[0].pose.distance).toBeGreaterThan(9);
    expect(built.camera?.keys[1].pose.distance).toBeLessThan(9);
  });

  it("orbit round comes back to the angle it left, a full turn later", () => {
    const built = byId("orbit-round");
    const keys = built.camera?.keys ?? [];
    expect(keys[1].pose.azimuthDeg - keys[0].pose.azimuthDeg).toBe(360);
  });

  it("crane down drops height while the aim holds", () => {
    const built = byId("crane-down");
    const keys = built.rig?.keys ?? [];
    expect(keys[0].pose.position[1]).toBeGreaterThan(keys[1].pose.position[1]);
    expect(keys[0].pose.aim.at).toEqual(keys[1].pose.aim.at);
  });

  it("fly through smooths by default and aims along its path", () => {
    const built = byId("fly-through");
    expect(built.rig?.keys).toHaveLength(4);
    expect(built.rig?.keys.every((k) => k.pose.aim.mode === "tangent")).toBe(true);
    expect(built.rig?.segments.every((s) => s.smooth !== false)).toBe(true);
  });

  it("parallax slide trucks sideways with one fixed aim", () => {
    const built = byId("parallax-slide");
    const keys = built.rig?.keys ?? [];
    expect(keys[1].pose.position[0] - keys[0].pose.position[0]).toBeCloseTo(3.6, 6);
    expect(keys[0].pose.aim.at).toEqual(keys[1].pose.aim.at);
  });

  it("dolly zoom trades distance against lens, with the lens lagging", () => {
    const built = byId("dolly-zoom");
    const keys = built.rig?.keys ?? [];
    expect(Math.abs(keys[1].pose.position[2])).toBeGreaterThan(Math.abs(keys[0].pose.position[2]));
    expect(keys[1].pose.fov ?? 0).toBeLessThan(keys[0].pose.fov ?? 0);
    expect(built.rig?.segments[0].easeLens).toBe("inCubic");
    // The lag is observable: a quarter through, the lens has moved less of its range than the move.
    const track = normalizeSceneRig(built.rig, "preset");
    if (!track) throw new Error("track expected");
    const at = sampleSceneRig(track, 500);
    const startFov = keys[0].pose.fov ?? 45;
    const endFov = keys[1].pose.fov ?? 45;
    const lensProgress = ((at.fov ?? 45) - startFov) / (endFov - startFov);
    const startZ = keys[0].pose.position[2];
    const moveProgress = (at.position[2] - startZ) / (keys[1].pose.position[2] - startZ);
    expect(lensProgress).toBeLessThan(moveProgress);
  });
});
