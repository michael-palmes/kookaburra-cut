import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc, SceneDocRigPose } from "./sceneDocSchema";
import {
  defaultRigPose,
  LAYERED_SCREENSHOT_AIM_ID,
  mixAimDistance,
  mixRigPose,
  normalizeSceneRig,
  RIG_FOV_MAX,
  type SceneRigTrack,
  sampleSceneRig,
  slerpUnit,
  toCanonical,
  VIDEO_WINDOW_AIM_ID,
} from "./sceneRig";

type V3 = [number, number, number];

const at = (v: V3): SceneDocRigPose["aim"] => ({ mode: "point", at: v });

const pose = (position: V3, over: Partial<SceneDocRigPose> = {}): SceneDocRigPose => ({
  position,
  aim: at([0, 0, 0]),
  ...over,
});

const track = (raw: NonNullable<SceneDoc["cameraRig"]>, doc?: SceneDoc): SceneRigTrack => {
  const t = normalizeSceneRig(raw, "test", doc);
  if (!t) throw new Error("rig track expected");
  return t;
};

const len = (v: V3) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("slerpUnit", () => {
  it("returns the endpoints exactly", () => {
    const a: V3 = [1, 0, 0];
    const b: V3 = [0, 1, 0];
    expect(slerpUnit(a, b, 0)).toEqual(a);
    const end = slerpUnit(a, b, 1);
    expect(end[0]).toBeCloseTo(0, 12);
    expect(end[1]).toBeCloseTo(1, 12);
  });

  it("halves a 90 degree turn at the midpoint", () => {
    const mid = slerpUnit([1, 0, 0], [0, 1, 0], 0.5);
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(mid[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it("keeps unit length across the range", () => {
    for (let i = 0; i <= 10; i++) {
      expect(len(slerpUnit([1, 0, 0], [0, 0.6, 0.8], i / 10))).toBeCloseTo(1, 12);
    }
  });

  it("falls back to a normalised lerp for near-parallel inputs", () => {
    const a: V3 = [1, 0, 0];
    const b: V3 = [1, 0.001, 0];
    const mid = slerpUnit(a, b, 0.5);
    expect(len(mid)).toBeCloseTo(1, 12);
    expect(mid[1]).toBeCloseTo(0.0005, 6);
  });

  it("picks the SAME antipodal axis every call (no floating-point luck)", () => {
    const a: V3 = [0, 0, -1];
    const b: V3 = [0, 0, 1];
    const mid = slerpUnit(a, b, 0.5);
    expect(mid[0]).toBeCloseTo(1, 12);
    expect(mid[1]).toBeCloseTo(0, 12);
    expect(mid[2]).toBeCloseTo(0, 12);
    expect(slerpUnit(a, b, 0.5)).toEqual(mid);
    // ...and it still lands on b.
    const end = slerpUnit(a, b, 1);
    expect(end[2]).toBeCloseTo(1, 12);
  });
});

describe("mixAimDistance", () => {
  it("is even in log space (a 6 -> 1 push hits the geometric mean at halfway)", () => {
    expect(mixAimDistance(6, 1, 0.5)).toBeCloseTo(Math.sqrt(6), 12);
    expect(mixAimDistance(6, 1, 0)).toBeCloseTo(6, 12);
    expect(mixAimDistance(6, 1, 1)).toBeCloseTo(1, 12);
  });

  it("degrades to linear rather than NaN when an end is zero", () => {
    expect(mixAimDistance(0, 4, 0.5)).toBe(2);
    expect(mixAimDistance(4, 0, 0.25)).toBe(3);
  });
});

describe("normalizeSceneRig", () => {
  it("returns null for missing/empty rigs", () => {
    expect(normalizeSceneRig(undefined, "t")).toBeNull();
    expect(normalizeSceneRig({ keys: [], segments: [] }, "t")).toBeNull();
  });

  it("drops invalid keys and duplicate ids, and clamps negative times", () => {
    const t = track({
      keys: [
        { id: "a", tMs: -50, pose: pose([0, 0, 5]) },
        { id: "a", tMs: 100, pose: pose([0, 0, 4]) },
        { id: "b", tMs: 200, pose: pose([Number.NaN, 0, 4]) },
        {
          id: "c",
          tMs: 300,
          pose: { position: [0, 0, 3], aim: { mode: "object", id: "", at: [0, 0, 0] } },
        },
      ],
      segments: [],
    });
    expect(t.keys).toHaveLength(1);
    expect(t.keys[0].tMs).toBe(0);
  });

  it("drops segments with missing keys, reversed times, or overlaps", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose([0, 0, 5]) },
        { id: "b", tMs: 1000, pose: pose([1, 0, 5]) },
        { id: "c", tMs: 500, pose: pose([2, 0, 5]) },
      ],
      segments: [
        { from: "a", to: "ghost", ease: "linear" },
        { from: "b", to: "a", ease: "linear" },
        { from: "a", to: "b", ease: "linear" },
        { from: "c", to: "b", ease: "linear" },
      ],
    });
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].from.id).toBe("a");
  });

  it("smooth polarity: absent means smooth, explicit false means straight", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose([0, 0, 5]) },
        { id: "b", tMs: 1000, pose: pose([1, 0, 5]) },
        { id: "c", tMs: 2000, pose: pose([2, 0, 5]) },
      ],
      segments: [
        { from: "a", to: "b", ease: "linear" },
        { from: "b", to: "c", ease: "linear", smooth: false },
      ],
    });
    expect(t.segments[0].smooth).toBe(true);
    expect(t.segments[1].smooth).toBe(false);
  });

  it("clamps fov to the authored range, warning and naming the key", () => {
    const warn = vi.spyOn(console, "warn");
    const t = track({
      keys: [{ id: "wide", tMs: 0, pose: pose([0, 0, 5], { fov: 140 }) }],
      segments: [],
    });
    expect(t.keys[0].pose.fov).toBe(RIG_FOV_MAX);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('"wide"'))).toBe(true);
  });

  it("drops unknown channel eases so the channel falls back to the segment's", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose([0, 0, 5]) },
        { id: "b", tMs: 1000, pose: pose([1, 0, 5]) },
      ],
      segments: [
        {
          from: "a",
          to: "b",
          ease: "linear",
          easePosition: "outCubic",
          easeLens: "notAnEase",
        },
      ],
    });
    expect(t.segments[0].easePosition).toBe("outCubic");
    expect(t.segments[0].easeLens).toBeUndefined();
  });

  it("resolves an object aim against the owning doc's device placement", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [{ id: "phone", model: "iphone-15-pro", placement: { position: [1, 2, 3] } }],
    };
    const t = track(
      {
        keys: [
          {
            id: "a",
            tMs: 0,
            pose: { position: [0, 0, 5], aim: { mode: "object", id: "phone", at: [0, 0, 0] } },
          },
        ],
        segments: [],
      },
      doc,
    );
    expect(t.keys[0].pose.aim.at).toEqual([1, 2, 3]);
  });

  it("resolves the two singleton bindables", () => {
    const doc: SceneDoc = {
      version: 1,
      videoWindow: {
        media: { src: "assets/a.mp4" },
        stage: { type: "color", color: "#000" },
        radius: "macos",
      },
      layeredScreenshot: {
        layers: [],
        pose: { spread: 0.5, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0.5, -0.25] },
      },
    };
    const rig = (id: string) =>
      track(
        {
          keys: [
            {
              id: "a",
              tMs: 0,
              pose: { position: [0, 0, 5], aim: { mode: "object", id, at: [9, 9, 9] } },
            },
          ],
          segments: [],
        },
        doc,
      ).keys[0].pose.aim.at;
    expect(rig(VIDEO_WINDOW_AIM_ID)).toEqual([0, 0, 0]);
    expect(rig(LAYERED_SCREENSHOT_AIM_ID)).toEqual([0.5, -0.25, 0]);
  });

  it("a missing binding warns once and keeps the baked point (never a broken shot)", () => {
    const warn = vi.spyOn(console, "warn");
    const t = track(
      {
        keys: [
          {
            id: "a",
            tMs: 0,
            pose: { position: [0, 0, 5], aim: { mode: "object", id: "gone", at: [1, 1, 0] } },
          },
          {
            id: "b",
            tMs: 900,
            pose: { position: [0, 1, 5], aim: { mode: "object", id: "gone", at: [1, 1, 0] } },
          },
        ],
        segments: [],
      },
      { version: 1 },
    );
    expect(t.keys[0].pose.aim.at).toEqual([1, 1, 0]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("gone"))).toHaveLength(1);
  });
});

describe("sampleSceneRig", () => {
  const straight = track({
    keys: [
      { id: "a", tMs: 1000, pose: pose([0, 0, 6]) },
      { id: "b", tMs: 2000, pose: pose([0, 0, 2]) },
    ],
    segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
  });

  it("holds the first key before it and the last key after it", () => {
    expect(sampleSceneRig(straight, 0).position).toEqual([0, 0, 6]);
    expect(sampleSceneRig(straight, 99999).position).toEqual([0, 0, 2]);
  });

  it("a straight segment lerps position and logs the aim distance", () => {
    const mid = sampleSceneRig(straight, 1500);
    expect(mid.position[2]).toBeCloseTo(4, 12);
    // The look point stays on the origin only if distance mixed linearly; it
    // mixes logarithmically, so the aim leads the position slightly.
    expect(mid.lookAt[2]).toBeCloseTo(4 - Math.sqrt(12), 12);
  });

  it("half-open segments: jump holds `from` and lands `to` exactly at the end", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose([0, 0, 5]) },
        { id: "b", tMs: 1000, pose: pose([3, 0, 5]) },
      ],
      segments: [{ from: "a", to: "b", ease: "jump", smooth: false }],
    });
    expect(sampleSceneRig(t, 999).position[0]).toBe(0);
    expect(sampleSceneRig(t, 1000).position[0]).toBe(3);
  });

  it("a lone smooth segment is exactly its straight lerp (reflected neighbours)", () => {
    const lone = track({
      keys: [
        { id: "a", tMs: 0, pose: pose([0, 0, 6]) },
        { id: "b", tMs: 1000, pose: pose([4, 2, 2]) },
      ],
      segments: [{ from: "a", to: "b", ease: "linear" }],
    });
    const smooth = sampleSceneRig(lone, 500).position;
    expect(smooth[0]).toBeCloseTo(2, 12);
    expect(smooth[1]).toBeCloseTo(1, 12);
    expect(smooth[2]).toBeCloseTo(4, 12);
  });

  it("a smoothed interior segment curves off the chord; the straight one doesn't", () => {
    const keys = [
      { id: "a", tMs: 0, pose: pose([-4, 0, 4]) },
      { id: "b", tMs: 1000, pose: pose([0, 3, 4]) },
      { id: "c", tMs: 2000, pose: pose([4, 0, 4]) },
    ];
    const segments = [
      { from: "a", to: "b", ease: "linear" },
      { from: "b", to: "c", ease: "linear" },
    ];
    const curved = sampleSceneRig(track({ keys, segments }), 500).position;
    const flat = sampleSceneRig(
      track({ keys, segments: segments.map((s) => ({ ...s, smooth: false })) }),
      500,
    ).position;
    expect(flat[0]).toBeCloseTo(-2, 12);
    expect(flat[1]).toBeCloseTo(1.5, 12);
    expect(Math.abs(curved[1] - flat[1])).toBeGreaterThan(0.05);
  });

  it("channel eases diverge: a lens override curves fov differently to position", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose([0, 0, 6], { fov: 20 }) },
        { id: "b", tMs: 1000, pose: pose([0, 0, 2], { fov: 80 }) },
      ],
      segments: [{ from: "a", to: "b", ease: "linear", smooth: false, easeLens: "inQuad" }],
    });
    const s = sampleSceneRig(t, 250);
    expect(s.position[2]).toBeCloseTo(5, 12); // linear position
    expect(s.fov).toBeCloseTo(20 + 60 * 0.0625, 12); // inQuad(0.25) = 0.0625
  });

  it("fov stays undefined when no key authored one (the project track keeps it)", () => {
    expect(sampleSceneRig(straight, 1500).fov).toBeUndefined();
    expect(sampleSceneRig(straight, 0).fov).toBeUndefined();
  });

  it("roll interpolates on the rotation channel", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose([0, 0, 5], { rollDeg: 0 }) },
        { id: "b", tMs: 1000, pose: pose([0, 0, 5], { rollDeg: 20 }) },
      ],
      segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
    });
    expect(sampleSceneRig(t, 500).rollDeg).toBeCloseTo(10, 12);
    expect(sampleSceneRig(t, 0).rollDeg).toBe(0);
  });

  it("a 180 degree pan-in-place turns without the aim passing through the camera", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: pose([0, 0, 0], { aim: { mode: "point", at: [0, 0, -1] } }) },
        { id: "b", tMs: 1000, pose: pose([0, 0, 0], { aim: { mode: "point", at: [0, 0, 1] } }) },
      ],
      segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
    });
    for (let i = 1; i < 10; i++) {
      const s = sampleSceneRig(t, i * 100);
      expect(len(s.lookAt as V3)).toBeCloseTo(1, 10);
    }
  });
});

describe("tangent aim", () => {
  const flythrough = (smooth: boolean) =>
    track({
      keys: [
        {
          id: "a",
          tMs: 0,
          pose: { position: [-4, 0, 6], aim: { mode: "tangent", at: [0, 0, 0] } },
        },
        {
          id: "b",
          tMs: 1000,
          pose: { position: [0, 2, 3], aim: { mode: "tangent", at: [0, 0, 0] } },
        },
        {
          id: "c",
          tMs: 2000,
          pose: { position: [4, 0, 0], aim: { mode: "tangent", at: [0, 0, 0] } },
        },
      ],
      segments: [
        { from: "a", to: "b", ease: "linear", smooth },
        { from: "b", to: "c", ease: "linear", smooth },
      ],
    });

  it("a straight segment aims along its chord", () => {
    const s = sampleSceneRig(flythrough(false), 500);
    const dir: V3 = [
      s.lookAt[0] - s.position[0],
      s.lookAt[1] - s.position[1],
      s.lookAt[2] - s.position[2],
    ];
    const chord: V3 = [4, 2, -3];
    const scale = len(dir) / len(chord);
    expect(dir[0]).toBeCloseTo(chord[0] * scale, 10);
    expect(dir[1]).toBeCloseTo(chord[1] * scale, 10);
    expect(dir[2]).toBeCloseTo(chord[2] * scale, 10);
  });

  it("a smoothed segment aims along the spline derivative, not the chord", () => {
    const s = sampleSceneRig(flythrough(true), 900);
    const dir: V3 = [
      s.lookAt[0] - s.position[0],
      s.lookAt[1] - s.position[1],
      s.lookAt[2] - s.position[2],
    ];
    const chord: V3 = [4, 2, -3];
    const cos =
      (dir[0] * chord[0] + dir[1] * chord[1] + dir[2] * chord[2]) / (len(dir) * len(chord));
    expect(cos).toBeGreaterThan(0.8); // same general heading
    expect(cos).toBeLessThan(0.9999); // but demonstrably not the chord
  });

  it("a held key outside any segment falls back to its baked point", () => {
    const s = sampleSceneRig(flythrough(false), 5000);
    expect(s.position).toEqual([4, 0, 0]);
    expect(s.lookAt[0]).toBeCloseTo(0, 10);
    expect(s.lookAt[1]).toBeCloseTo(0, 10);
    expect(s.lookAt[2]).toBeCloseTo(0, 10);
  });

  it("a stationary key pair has no tangent, so it falls back to the baked point", () => {
    const t = track({
      keys: [
        { id: "a", tMs: 0, pose: { position: [0, 0, 5], aim: { mode: "tangent", at: [1, 0, 5] } } },
        {
          id: "b",
          tMs: 1000,
          pose: { position: [0, 0, 5], aim: { mode: "tangent", at: [1, 0, 5] } },
        },
      ],
      segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
    });
    const s = sampleSceneRig(t, 500);
    expect(s.lookAt[0]).toBeCloseTo(1, 10);
    expect(s.lookAt[1]).toBeCloseTo(0, 10);
  });
});

describe("canonical helpers", () => {
  it("a degenerate aim (look point on the camera) guards to a forward of [0,0,-1]", () => {
    const c = toCanonical({ position: [1, 2, 3], aim: at([1, 2, 3]) });
    expect(c.forward).toEqual([0, 0, -1]);
    expect(c.aimDistance).toBe(1);
  });

  it("mixRigPose blends applied poses through the canonical path", () => {
    const a = { position: [0, 0, 6] as V3, lookAt: [0, 0, 0] as V3, rollDeg: 0 };
    const b = { position: [0, 0, 2] as V3, lookAt: [0, 0, 0] as V3, rollDeg: 40 };
    const mid = mixRigPose(a, b, 0.5);
    expect(mid.position[2]).toBeCloseTo(4, 12);
    expect(mid.rollDeg).toBeCloseTo(20, 12);
  });

  it("the default rig pose is the base camera as a free pose", () => {
    expect(defaultRigPose()).toEqual({
      position: [0, 0, 5],
      aim: { mode: "point", at: [0, 0, 0] },
    });
  });
});
