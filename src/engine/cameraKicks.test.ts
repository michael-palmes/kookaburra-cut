import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCameraKicks,
  type CameraKick,
  cameraKickBreaks,
  cameraKickPeaks,
  cameraKicksEndMs,
  KICK_FOV_MAX,
  KICK_FOV_MIN,
  resolveCameraKicks,
} from "./cameraKicks";
import { baseCameraPose, type CameraPose } from "./cameraTrack";
import { ease } from "./ease";
import { DEFAULT_MOTION_BLUR } from "./motionBlur";
import type { ProjectMusic } from "./musicTime";
import { resolveFrameCameras, sceneCameraTracks } from "./sceneCamera";
import { parseSceneDoc, type SceneDocCameraKick } from "./sceneDocSchema";
import { normalizeSceneRig, rigOverscan } from "./sceneRig";
import { resolveAt, type SceneSlot } from "./sceneTimeline";
import { cameraBreaks, clampSampleMs } from "./shutter";
import { buildShutterPlan, frameCameraShutter } from "./shutterPlan";

const DEG = Math.PI / 180;

// 120 bpm in 4/4 from track 0: a beat is 500 ms, a bar 2000 ms, so bar 13 sits at project 24000.
const MUSIC: ProjectMusic = {
  grid: { bpm: 120, offsetMs: 0, beatsPerBar: 4 },
  startOffsetMs: 0,
  cues: { drop: "bar:3", flash: 9000 },
  sections: {},
};

const kicksOf = (raw: SceneDocCameraKick[], sceneStartMs = 0, music?: ProjectMusic) => {
  const kicks = resolveCameraKicks(raw, { music, sceneStartMs });
  if (!kicks) throw new Error("kicks expected");
  return kicks;
};

const base = (): CameraPose => ({ position: [0, 0, 5], lookAt: [0, 0, 0], fov: 45 });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("parseSceneDoc cameraKicks", () => {
  const parse = (cameraKicks: unknown) =>
    parseSceneDoc({ version: 1, cameraKicks }, "test")?.cameraKicks;

  it("keeps a valid kick verbatim, position and unknown fields included", () => {
    const kick = { at: "bar:13", zoom: 1.04, releaseMs: 300, note: "kept" };
    const parsed = parse([kick]);
    expect(parsed?.[0]).toBe(kick);
    expect(parsed?.[0].at).toBe("bar:13");
  });

  it("drops a kick without a usable at, releaseMs or channel", () => {
    expect(parse([{ at: -1, zoom: 1.1, releaseMs: 100 }])).toBeUndefined();
    expect(parse([{ at: "beat 3", zoom: 1.1, releaseMs: 100 }])).toBeUndefined();
    expect(parse([{ at: 100, zoom: 1.1 }])).toBeUndefined();
    expect(parse([{ at: 100, releaseMs: -5, zoom: 1.1 }])).toBeUndefined();
    expect(parse([{ at: 100, releaseMs: 100 }])).toBeUndefined();
    expect(parse("bar:1")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("drops a bad optional field alone, and the kick once no channel is left", () => {
    const parsed = parse([
      { at: 0, zoom: 1.2, releaseMs: 100, ease: "wobble", attackMs: -1, offset: [1, 2] },
    ]);
    expect(parsed).toEqual([{ at: 0, zoom: 1.2, releaseMs: 100 }]);
    expect(parse([{ at: 0, zoom: 9, releaseMs: 100 }])).toBeUndefined();
    expect(parse([{ at: 0, zoom: 0.25, rollDeg: "x", releaseMs: 100 }])).toEqual([
      { at: 0, zoom: 0.25, releaseMs: 100 },
    ]);
  });

  it("keeps the good kicks of a mixed list in order", () => {
    const a = { at: 0, rollDeg: 2, releaseMs: 100 };
    const b = { at: "cue:drop", offset: [0, 0, -0.2], releaseMs: 200 };
    expect(parse([a, { at: 5 }, b])).toEqual([a, b]);
  });
});

describe("resolveCameraKicks", () => {
  it("is null with nothing to resolve", () => {
    expect(resolveCameraKicks(undefined, undefined)).toBeNull();
    expect(resolveCameraKicks([], { sceneStartMs: 0 })).toBeNull();
  });

  it("uses a numeric at as is and fills the envelope defaults", () => {
    const [kick] = kicksOf([{ at: 1234.5, zoom: 1.1, releaseMs: 300 }]);
    expect(kick).toEqual({
      atMs: 1234.5,
      at: 1234.5,
      index: 0,
      zoom: 1.1,
      attackMs: 0,
      holdMs: 0,
      releaseMs: 300,
      ease: "outQuad",
    });
  });

  it("resolves bar, cue and nudged positions to integer scene-local ms", () => {
    const kicks = kicksOf(
      [
        { at: "bar:13", zoom: 1.04, releaseMs: 300 },
        { at: "cue:drop", zoom: 1.04, releaseMs: 300 },
        { at: "bar:13.2+40ms", zoom: 1.04, releaseMs: 300 },
        { at: "cue:flash", zoom: 1.04, releaseMs: 300 },
      ],
      20000,
      MUSIC,
    );
    expect(kicks.map((k) => k.atMs)).toEqual([-16000, -11000, 4000, 4540]);
    expect(kicks.map((k) => k.at)).toEqual(["cue:drop", "cue:flash", "bar:13", "bar:13.2+40ms"]);
  });

  it("drops an unresolvable position with one warning and never touches the doc", () => {
    const raw: SceneDocCameraKick[] = [
      { at: "bar:13", zoom: 1.04, releaseMs: 300 },
      { at: 500, rollDeg: 3, releaseMs: 200 },
    ];
    const frozen = structuredClone(raw);
    const messages: string[] = [];
    const kicks = resolveCameraKicks(raw, { sceneStartMs: 0 }, (m) => messages.push(m));
    expect(kicks?.map((k) => k.atMs)).toEqual([500]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("bar:13");
    expect(raw).toEqual(frozen);
  });

  it("orders by resolved start, then authored index", () => {
    const kicks = kicksOf([
      { at: 900, zoom: 1.1, releaseMs: 100 },
      { at: 100, rollDeg: 1, releaseMs: 100 },
      { at: 900, rollDeg: 2, releaseMs: 100 },
    ]);
    expect(kicks.map((k) => k.index)).toEqual([1, 0, 2]);
  });
});

describe("applyCameraKicks", () => {
  const zoomKick = kicksOf([{ at: 1000, zoom: 1.25, attackMs: 100, holdMs: 100, releaseMs: 200 }]);

  it("returns the base pose object itself outside every window", () => {
    const pose = base();
    expect(applyCameraKicks(pose, null, 1000)).toBe(pose);
    expect(applyCameraKicks(pose, [], 1000)).toBe(pose);
    expect(applyCameraKicks(pose, zoomKick, 999)).toBe(pose);
    expect(applyCameraKicks(pose, zoomKick, 1000)).toBe(pose); // attack starts at exactly 0
    expect(applyCameraKicks(pose, zoomKick, 1400)).toBe(pose);
    expect(applyCameraKicks(pose, zoomKick, 50_000)).toBe(pose);
  });

  it("returns the base pose when a live kick moves nothing", () => {
    const pose = base();
    const idle = kicksOf([
      { at: 0, zoom: 1, releaseMs: 500 },
      { at: 0, offset: [0, 0, 0], releaseMs: 500 },
      { at: 0, rollDeg: 0, releaseMs: 500 },
    ]);
    expect(applyCameraKicks(pose, idle, 100)).toBe(pose);
  });

  it("zooms in tan space and leaves the other channels' objects alone", () => {
    const pose: CameraPose = { ...base(), dof: { mode: "depth", blur: 1 } as CameraPose["dof"] };
    const peak = applyCameraKicks(pose, zoomKick, 1150);
    expect(peak).not.toBe(pose);
    expect(peak.fov).toBeCloseTo(2 * Math.atan(Math.tan(22.5 * DEG) / 1.25) * (180 / Math.PI), 12);
    expect(peak.position).toBe(pose.position);
    expect(peak.lookAt).toBe(pose.lookAt);
    expect(peak.dof).toBe(pose.dof);
    expect(peak.rollDeg).toBeUndefined();
    const e = 1 - ease("outQuad", 0.5);
    const falling = applyCameraKicks(pose, zoomKick, 1300);
    expect(falling.fov).toBeCloseTo(
      2 * Math.atan(Math.tan(22.5 * DEG) / (1 + 0.25 * e)) * (180 / Math.PI),
      12,
    );
  });

  it("clamps the lens to 15..90", () => {
    const tight = kicksOf([{ at: 0, zoom: 4, releaseMs: 100 }]);
    const wide = kicksOf([{ at: 0, zoom: 0.25, releaseMs: 100 }]);
    expect(applyCameraKicks(base(), tight, 0).fov).toBe(KICK_FOV_MIN);
    expect(applyCameraKicks(base(), wide, 0).fov).toBe(KICK_FOV_MAX);
  });

  it("shifts the position and look point together in camera space", () => {
    const shove = kicksOf([{ at: 0, offset: [1, 0.5, -1], releaseMs: 100 }]);
    const kicked = applyCameraKicks(base(), shove, 0);
    expect(kicked.position).toEqual([1, 0.5, 4]);
    expect(kicked.lookAt).toEqual([1, 0.5, -1]);
    expect(kicked.fov).toBe(45);
    // A banked camera's right is the world's up.
    const banked = applyCameraKicks(
      { ...base(), rollDeg: 90 },
      kicksOf([{ at: 0, offset: [1, 0, 0], releaseMs: 100 }]),
      0,
    );
    expect(banked.position[0]).toBeCloseTo(0, 12);
    expect(banked.position[1]).toBeCloseTo(1, 12);
    expect(banked.rollDeg).toBe(90);
  });

  it("adds roll on top of the base roll", () => {
    const tilt = kicksOf([{ at: 0, rollDeg: 4, releaseMs: 200, ease: "linear" }]);
    expect(applyCameraKicks(base(), tilt, 0).rollDeg).toBe(4);
    expect(applyCameraKicks({ ...base(), rollDeg: 10 }, tilt, 100).rollDeg).toBe(12);
  });

  it("sums offsets and roll, multiplies zoom, and cancels opposite rolls", () => {
    const pair = kicksOf([
      { at: 0, offset: [0.5, 0, 0], zoom: 1.1, releaseMs: 100 },
      { at: 0, offset: [0.25, 0, 0], zoom: 1.2, releaseMs: 100 },
    ]);
    const kicked = applyCameraKicks(base(), pair, 0);
    expect(kicked.position[0]).toBe(0.75);
    expect(kicked.fov).toBeCloseTo(
      2 * Math.atan(Math.tan(22.5 * DEG) / (1.1 * 1.2)) * (180 / Math.PI),
      12,
    );
    const pose = base();
    const cancel = kicksOf([
      { at: 0, rollDeg: 5, releaseMs: 100 },
      { at: 0, rollDeg: -5, releaseMs: 100 },
    ]);
    expect(applyCameraKicks(pose, cancel, 50)).toBe(pose);
  });

  it("applies in a fixed order whatever order the sidecar lists them", () => {
    const a = {
      at: 0,
      offset: [0.1, 0.2, 0.3] as [number, number, number],
      zoom: 1.07,
      releaseMs: 400,
    };
    const b = {
      at: 40,
      offset: [0.7, -0.3, 0.11] as [number, number, number],
      zoom: 0.93,
      releaseMs: 300,
    };
    const one = applyCameraKicks(base(), kicksOf([a, b]), 120);
    const two = applyCameraKicks(base(), kicksOf([b, a]), 120);
    expect(two).toEqual(one);
    expect(Object.is(two.fov, one.fov)).toBe(true);
  });
});

describe("kick ends, breaks and peaks", () => {
  it("ends where the envelope returns to zero", () => {
    expect(cameraKicksEndMs(null)).toBe(0);
    expect(
      cameraKicksEndMs(
        kicksOf([
          { at: 100, zoom: 1.1, attackMs: 50, holdMs: 20, releaseMs: 300 },
          { at: 0, zoom: 1.1, releaseMs: 100 },
        ]),
      ),
    ).toBe(470);
  });

  it("breaks on a snap: a zero attack, a zero release and the jump ease", () => {
    const k = (kick: Omit<SceneDocCameraKick, "zoom">) => kicksOf([{ zoom: 1.1, ...kick }]);
    expect(cameraKickBreaks(k({ at: 500, releaseMs: 300 }))).toEqual([500]);
    expect(cameraKickBreaks(k({ at: 500, attackMs: 40, releaseMs: 300 }))).toEqual([]);
    expect(cameraKickBreaks(k({ at: 500, attackMs: 40, holdMs: 60, releaseMs: 0 }))).toEqual([600]);
    expect(cameraKickBreaks(k({ at: 500, attackMs: 40, releaseMs: 300, ease: "jump" }))).toEqual([
      540, 840,
    ]);
    expect(cameraKickBreaks(k({ at: 500, releaseMs: 0 }))).toEqual([]);
  });

  it("peaks at the start and end of the hold", () => {
    expect(
      cameraKickPeaks(
        kicksOf([
          { at: 100, zoom: 1.1, attackMs: 50, holdMs: 20, releaseMs: 300 },
          { at: 0, zoom: 1.1, releaseMs: 100 },
        ]),
      ),
    ).toEqual([0, 150, 170]);
  });

  it("adds kick breaks to the camera breaks, kicks-only scenes included", () => {
    const kicks = kicksOf([{ at: 500, zoom: 1.1, releaseMs: 300 }]);
    expect(cameraBreaks(sceneCameraTracks(null, null, kicks))).toEqual([500]);
    expect(cameraBreaks(sceneCameraTracks(null, null, null))).toEqual([]);
  });

  it("clamps a straddling sample onto the snap so the pre-kick pose never ghosts", () => {
    const breaks = [500];
    expect(clampSampleMs(495, 503, 2000, breaks)).toBeLessThan(500);
    expect(clampSampleMs(503, 495, 2000, breaks)).toBe(500);
  });
});

describe("motion blur over a kick", () => {
  const slots: SceneSlot[] = [{ index: 0, id: "s0", startMs: 0, endMs: 2000, durationMs: 2000 }];
  const tracks = [sceneCameraTracks(null, null, kicksOf([{ at: 500, zoom: 1.3, releaseMs: 400 }]))];
  const plan = buildShutterPlan({
    fps: 60,
    aspect: 16 / 9,
    slots,
    sceneDocs: [{ version: 1 }],
    motionBlur: { ...DEFAULT_MOTION_BLUR, enabled: true },
  });
  const at = (tMs: number) => {
    if (!plan) throw new Error("plan expected");
    const resolved = resolveAt(slots, tMs);
    const centre = resolveFrameCameras(tracks, undefined, resolved, tMs);
    return frameCameraShutter(plan, resolved, tMs, tracks, undefined, centre);
  };

  it("smears the release and never reaches back past the snap", () => {
    const release = at(600);
    expect(release).not.toBeNull();
    const fovs = release?.plans.map((p) => p?.solo?.fov ?? 0) ?? [];
    expect(new Set(fovs).size).toBe(fovs.length);
    const snap = at(503);
    const first = snap?.plans[0]?.solo?.fov ?? 0;
    expect(first).toBeLessThan(45);
  });

  it("holds still away from the kick", () => {
    expect(at(1500)).toBeNull();
    expect(at(200)).toBeNull();
  });
});

describe("rigOverscan with kicks", () => {
  const BASE_HEIGHT = 2 * Math.tan(22.5 * DEG) * 5;
  const FRAME = { width: BASE_HEIGHT * (16 / 9), height: BASE_HEIGHT };
  const rig = normalizeSceneRig(
    {
      keys: [
        { id: "a", tMs: 0, pose: { position: [0, 0, 5], aim: { mode: "point", at: [0, 0, 0] } } },
        {
          id: "b",
          tMs: 2000,
          pose: { position: [0.5, 0, 5], aim: { mode: "point", at: [0.5, 0, 0] } },
        },
      ],
      segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
    },
    "test",
  );
  if (!rig) throw new Error("rig expected");

  it("is unchanged without kicks", () => {
    const plain = rigOverscan(rig, FRAME, -2.4);
    expect(rigOverscan(rig, FRAME, -2.4, 1, undefined, null)).toBe(plain);
    expect(rigOverscan(rig, FRAME, -2.4, 1, undefined, [])).toBe(plain);
  });

  it("covers a kick that pulls out or shoves past the rig's travel", () => {
    const plain = rigOverscan(rig, FRAME, -2.4);
    const out: CameraKick[] = kicksOf([{ at: 1000, zoom: 0.8, holdMs: 100, releaseMs: 300 }]);
    expect(rigOverscan(rig, FRAME, -2.4, 1, undefined, out)).toBeGreaterThan(plain);
    const shove = kicksOf([{ at: 1000, offset: [0.6, 0, 0], attackMs: 50, releaseMs: 300 }]);
    expect(rigOverscan(rig, FRAME, -2.4, 1, undefined, shove)).toBeGreaterThan(plain);
    const push = kicksOf([{ at: 1000, zoom: 1.2, releaseMs: 300 }]);
    expect(rigOverscan(rig, FRAME, -2.4, 1, undefined, push)).toBe(plain);
  });
});

describe("baseCameraPose under kicks", () => {
  it("leaves the shared base untouched", () => {
    const pose = baseCameraPose();
    const before = structuredClone(pose);
    applyCameraKicks(
      pose,
      kicksOf([{ at: 0, offset: [1, 1, 1], zoom: 1.5, rollDeg: 9, releaseMs: 10 }]),
      0,
    );
    expect(pose).toEqual(before);
  });
});
