import { beforeEach, describe, expect, it, vi } from "vitest";
// Gate sidecars kept as committed fixtures (device-video-spike left the bundled set).
import gateHeroDoc from "./__fixtures__/device-video-spike/01-hero.json";
import gateTurntableDoc from "./__fixtures__/device-video-spike/02-turntable.json";
import { baseCameraPose } from "./cameraTrack";
import {
  buildSceneCameraTracks,
  defaultOrbitPose,
  hasSceneCameraTracks,
  normalizeSceneCamera,
  orbitFromView,
  orbitToView,
  resolveFrameCameras,
  type SceneCameraTrack,
  sampleSceneCamera,
} from "./sceneCamera";
import { parseSceneDoc, type SceneDoc, type SceneDocCameraPose } from "./sceneDocSchema";
import { resolveAt, type SceneSlot } from "./sceneTimeline";

const pose = (over: Partial<SceneDocCameraPose> = {}): SceneDocCameraPose => ({
  target: [0, 0, 0],
  azimuthDeg: 0,
  elevationDeg: 0,
  distance: 5,
  ...over,
});

const track = (raw: NonNullable<SceneDoc["camera"]>): SceneCameraTrack => {
  const t = normalizeSceneCamera(raw, "test");
  if (!t) throw new Error("track expected");
  return t;
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("orbit conversion", () => {
  it("azimuth 0 / elevation 0 sits on the target's +Z axis", () => {
    const view = orbitToView(pose());
    expect(view.position[0]).toBeCloseTo(0, 12);
    expect(view.position[1]).toBeCloseTo(0, 12);
    expect(view.position[2]).toBeCloseTo(5, 12);
    expect(view.lookAt).toEqual([0, 0, 0]);
  });

  it("matches the golden positions at authored angles", () => {
    const view = orbitToView(pose({ azimuthDeg: 90, elevationDeg: 30, distance: 4 }));
    expect(view.position[0]).toBeCloseTo(4 * Math.cos(Math.PI / 6), 12); // 3.4641016151377544
    expect(view.position[1]).toBeCloseTo(2, 12); // 4·sin(30°)
    expect(view.position[2]).toBeCloseTo(0, 12);
  });

  it("round-trips through orbitFromView", () => {
    const original = pose({ target: [1, -2, 0.5], azimuthDeg: 35, elevationDeg: -20, distance: 3 });
    const view = orbitToView(original);
    const back = orbitFromView(view.position, view.lookAt);
    expect(back.azimuthDeg).toBeCloseTo(35, 10);
    expect(back.elevationDeg).toBeCloseTo(-20, 10);
    expect(back.distance).toBeCloseTo(3, 10);
    expect(back.target).toEqual([1, -2, 0.5]);
  });

  it("the default orbit pose is the base camera exactly", () => {
    const d = defaultOrbitPose();
    expect(d).toEqual({ target: [0, 0, 0], azimuthDeg: 0, elevationDeg: 0, distance: 5 });
    const view = orbitToView(d);
    const base = baseCameraPose();
    expect(view.position[0]).toBeCloseTo(base.position[0], 12);
    expect(view.position[1]).toBeCloseTo(base.position[1], 12);
    expect(view.position[2]).toBeCloseTo(base.position[2], 12);
  });
});

describe("normalizeSceneCamera", () => {
  it("returns null for missing/empty tracks", () => {
    expect(normalizeSceneCamera(undefined, "t")).toBeNull();
    expect(normalizeSceneCamera({ keys: [], segments: [] }, "t")).toBeNull();
  });

  it("drops invalid keys, duplicate ids, and clamps negative times", () => {
    const t = track({
      keys: [
        { id: "a", tMs: -50, pose: pose() },
        { id: "a", tMs: 100, pose: pose() },
        { id: "b", tMs: 200, pose: { ...pose(), distance: Number.NaN } },
      ],
      segments: [],
    });
    expect(t.keys).toHaveLength(1);
    expect(t.keys[0].tMs).toBe(0);
  });

  it("resolves segments to SHARED key objects (edit one key, both segments move)", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose() },
        { id: "b", tMs: 1000, pose: pose({ azimuthDeg: 40 }) },
        { id: "c", tMs: 2000, pose: pose({ azimuthDeg: 80 }) },
      ],
      segments: [
        { from: "a", to: "b", ease: "linear" },
        { from: "b", to: "c", ease: "linear" },
      ],
    });
    expect(t.segments[0].to).toBe(t.segments[1].from);
  });

  it("drops segments with missing keys, reversed times, or overlaps", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose() },
        { id: "b", tMs: 1000, pose: pose({ azimuthDeg: 40 }) },
        { id: "c", tMs: 500, pose: pose({ azimuthDeg: 20 }) },
      ],
      segments: [
        { from: "a", to: "ghost", ease: "linear" },
        { from: "b", to: "a", ease: "linear" },
        { from: "a", to: "b", ease: "linear" },
        { from: "c", to: "b", ease: "linear" }, // starts inside a→b
      ],
    });
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].from.id).toBe("a");
  });
});

describe("sampleSceneCamera", () => {
  const twoSegments = track({
    keys: [
      { id: "a", tMs: 1000, pose: pose() },
      { id: "b", tMs: 2000, pose: pose({ azimuthDeg: 40, distance: 4 }) },
      { id: "c", tMs: 4000, pose: pose({ azimuthDeg: 40, distance: 4 }) },
      { id: "d", tMs: 5000, pose: pose({ azimuthDeg: 40, elevationDeg: 20, distance: 4 }) },
    ],
    segments: [
      { from: "a", to: "b", ease: "linear" },
      { from: "c", to: "d", ease: "jump" },
    ],
  });

  it("holds the first key before it (clamp at scene start)", () => {
    expect(sampleSceneCamera(twoSegments, 0)).toEqual(pose());
  });

  it("interpolates inside a segment with the named ease", () => {
    const mid = sampleSceneCamera(twoSegments, 1500);
    expect(mid.azimuthDeg).toBeCloseTo(20, 12);
    expect(mid.distance).toBeCloseTo(4.5, 12);
  });

  it("holds the segment's end pose through a gap (b → c gap at 2000–4000)", () => {
    expect(sampleSceneCamera(twoSegments, 3000)).toEqual(pose({ azimuthDeg: 40, distance: 4 }));
  });

  it("jump holds `from` for the whole segment and lands `to` exactly at its end", () => {
    expect(sampleSceneCamera(twoSegments, 4999).elevationDeg).toBe(0);
    expect(sampleSceneCamera(twoSegments, 5000).elevationDeg).toBe(20);
  });

  it("holds the last key after the track ends", () => {
    expect(sampleSceneCamera(twoSegments, 99999).elevationDeg).toBe(20);
  });

  it("a lone key with no segments is a whole-scene static reframe", () => {
    const lone = track({ keys: [{ id: "k", tMs: 0, pose: pose({ distance: 3 }) }], segments: [] });
    expect(sampleSceneCamera(lone, 0).distance).toBe(3);
    expect(sampleSceneCamera(lone, 4000).distance).toBe(3);
  });

  it("eased golden value (inOutQuad at 25% progress)", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose() },
        { id: "b", tMs: 1000, pose: pose({ azimuthDeg: 80 }) },
      ],
      segments: [{ from: "a", to: "b", ease: "inOutQuad" }],
    });
    // inOutQuad(0.25) = 0.125 → 80° · 0.125 = 10°
    expect(sampleSceneCamera(t, 250).azimuthDeg).toBeCloseTo(10, 12);
  });
});

describe("the device-video-spike gate sidecars (v7 · M5)", () => {
  // The gate project's committed camera tracks must parse into exactly the intended structure; a malformed sidecar degrades silently to "no track" and would turn the gate into a byte-identical-but-motionless no-op.
  const load = (raw: unknown, file: string) => {
    const doc = parseSceneDoc(raw, file);
    expect(doc?.camera).toBeDefined();
    const track = normalizeSceneCamera(doc?.camera, file);
    expect(track).not.toBeNull();
    return track as SceneCameraTrack;
  };

  it("01-hero: 5 keys, 3 segments (settle · gap · drift · jump), jump mid-transition", () => {
    const t = load(gateHeroDoc, "01-hero.json");
    expect(t.keys).toHaveLength(5);
    expect(t.segments).toHaveLength(3);
    expect(t.segments[2].ease).toBe("jump");
    // Structural gap between segment 1's end (900) and segment 2's start (1400).
    expect(t.segments[0].to.tMs).toBe(900);
    expect(t.segments[1].from.tMs).toBe(1400);
    // The jump lands at 2400, inside the 2000-2600 crossfade into scene 2.
    expect(t.segments[2].to.tMs).toBe(2400);
    expect(sampleSceneCamera(t, 2399).azimuthDeg).toBe(10); // still holding k4
    expect(sampleSceneCamera(t, 2400).azimuthDeg).toBe(24); // cut
    expect(sampleSceneCamera(t, 1100)).toEqual(sampleSceneCamera(t, 900)); // gap holds
  });

  it("02-turntable: settle-in covering the whole incoming crossfade", () => {
    const t = load(gateTurntableDoc, "02-turntable.json");
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].from.tMs).toBe(0);
    expect(sampleSceneCamera(t, 0).azimuthDeg).toBe(8);
    expect(sampleSceneCamera(t, 800).azimuthDeg).toBe(0);
  });
});

describe("resolveFrameCameras", () => {
  // Two 4000ms scenes, scene 1 entered via a 1000ms crossfade → total 7000ms.
  const slots: SceneSlot[] = [
    { index: 0, id: "s0", startMs: 0, endMs: 4000, durationMs: 4000 },
    {
      index: 1,
      id: "s1",
      startMs: 3000,
      endMs: 7000,
      durationMs: 4000,
      transitionIn: { type: "crossfade", durationMs: 1000 },
    },
  ];
  const docWithTrack: SceneDoc = {
    version: 1,
    camera: {
      keys: [{ id: "k", tMs: 0, pose: pose({ azimuthDeg: 40 }) }],
      segments: [],
    },
  };

  it("returns null when no scene declares a track (the byte-identity gate)", () => {
    const tracks = buildSceneCameraTracks([undefined, { version: 1 }]);
    expect(hasSceneCameraTracks(tracks)).toBe(false);
    expect(resolveFrameCameras(tracks, undefined, resolveAt(slots, 500), 500)).toBeNull();
  });

  it("solo frame on a tracked scene applies its orbit pose (project fov preserved)", () => {
    const tracks = buildSceneCameraTracks([docWithTrack, undefined]);
    const plan = resolveFrameCameras(tracks, undefined, resolveAt(slots, 500), 500);
    expect(plan?.solo).toBeDefined();
    expect(plan?.solo?.fov).toBe(45);
    expect(plan?.solo?.position[0]).toBeCloseTo(5 * Math.sin((40 * Math.PI) / 180), 12);
  });

  it("solo frame on an UNtracked scene in a tracked project falls back to the base pose", () => {
    const tracks = buildSceneCameraTracks([docWithTrack, undefined]);
    const plan = resolveFrameCameras(tracks, undefined, resolveAt(slots, 6000), 6000);
    expect(plan?.solo).toEqual(baseCameraPose());
  });

  it("transition frames carry per-target poses and the dominant overlay", () => {
    const tracks = buildSceneCameraTracks([docWithTrack, undefined]);
    const early = resolveFrameCameras(tracks, undefined, resolveAt(slots, 3200), 3200);
    expect(early?.a).toBeDefined();
    expect(early?.b).toEqual(baseCameraPose());
    expect(early?.overlay).toBe(early?.a); // progress 0.2 → A dominates
    const late = resolveFrameCameras(tracks, undefined, resolveAt(slots, 3800), 3800);
    expect(late?.overlay).toBe(late?.b); // progress 0.8 → B dominates
  });

  it("scene-local sampling offsets by the slot start (not global time)", () => {
    const moving: SceneDoc = {
      version: 1,
      camera: {
        keys: [
          { id: "a", tMs: 0, pose: pose() },
          { id: "b", tMs: 4000, pose: pose({ azimuthDeg: 40 }) },
        ],
        segments: [{ from: "a", to: "b", ease: "linear" }],
      },
    };
    const tracks = buildSceneCameraTracks([undefined, moving]);
    // Global 5000 → scene 1 local 2000 → 50% of a linear 0→40° move.
    const plan = resolveFrameCameras(tracks, undefined, resolveAt(slots, 5000), 5000);
    const half = orbitToView(pose({ azimuthDeg: 20 }));
    expect(plan?.solo?.position[0]).toBeCloseTo(half.position[0], 12);
  });

  it("untracked scenes fall back to the project-level track sample, and fov follows it", () => {
    const tracks = buildSceneCameraTracks([docWithTrack, undefined]);
    const projectTrack = [{ tMs: 0, fov: 30, position: [0, 1, 6] as [number, number, number] }];
    const plan = resolveFrameCameras(tracks, projectTrack, resolveAt(slots, 6000), 6000);
    expect(plan?.solo?.fov).toBe(30);
    expect(plan?.solo?.position).toEqual([0, 1, 6]);
    const tracked = resolveFrameCameras(tracks, projectTrack, resolveAt(slots, 500), 500);
    expect(tracked?.solo?.fov).toBe(30); // scene tracks never own fov
  });
});
