import { describe, expect, it } from "vitest";
import {
  deviceTrackPoseAt,
  deviceTrackPoseIsRest,
  deviceTrackSnapshotAt,
  nearestDeviceKey,
  resolveDeviceTrack,
} from "./sceneDeviceTrack";
import type { SceneDoc } from "./sceneDocSchema";

const doc = (deviceTrack: SceneDoc["deviceTrack"]): SceneDoc => ({ version: 1, deviceTrack });

const TRACK = doc({
  keys: [
    { id: "k1", tMs: 0, pose: { d1: { offset: [0, 0, 0] } } },
    { id: "k2", tMs: 1000, pose: { d1: { offset: [2, 1, 0], scale: 2, rotationDeg: [0, 90, 0] } } },
  ],
  segments: [{ from: "k1", to: "k2", ease: "linear" }],
});

describe("resolveDeviceTrack", () => {
  it("is null for a scene with no track, so an untracked device renders unchanged", () => {
    expect(resolveDeviceTrack(undefined)).toBeNull();
    expect(resolveDeviceTrack({ version: 1 })).toBeNull();
    expect(resolveDeviceTrack(doc({ keys: [], segments: [] }))).toBeNull();
  });

  it("sorts keys and resolves segment times", () => {
    const track = resolveDeviceTrack(
      doc({
        keys: [
          { id: "late", tMs: 900, pose: {} },
          { id: "early", tMs: 100, pose: {} },
        ],
        segments: [{ from: "early", to: "late", ease: "outCubic" }],
      }),
    );
    expect(track?.keys.map((k) => k.tMs)).toEqual([100, 900]);
    expect(track?.segments[0]).toMatchObject({ fromTMs: 100, toTMs: 900, ease: "outCubic" });
  });

  it("drops a segment whose ends do not resolve", () => {
    const track = resolveDeviceTrack(
      doc({
        keys: [{ id: "k1", tMs: 0, pose: {} }],
        segments: [{ from: "k1", to: "missing", ease: "linear" }],
      }),
    );
    expect(track?.segments).toEqual([]);
  });
});

describe("deviceTrackPoseAt", () => {
  const track = resolveDeviceTrack(TRACK);

  it("rests when there is no track at all", () => {
    const pose = deviceTrackPoseAt(null, "d1", 500);
    expect(pose).toEqual({
      offset: [0, 0, 0],
      rotationDeg: [0, 0, 0],
      scale: 1,
      lidDeg: undefined,
    });
  });

  it("rests for a device the track never mentions", () => {
    expect(deviceTrackPoseIsRest(deviceTrackPoseAt(track, "other", 500))).toBe(true);
  });

  it("eases across a segment", () => {
    const half = deviceTrackPoseAt(track, "d1", 500);
    expect(half.offset).toEqual([1, 0.5, 0]);
    expect(half.rotationDeg).toEqual([0, 45, 0]);
    expect(half.scale).toBe(1.5);
  });

  it("holds the latest key past the end of the track", () => {
    const after = deviceTrackPoseAt(track, "d1", 5000);
    expect(after.offset).toEqual([2, 1, 0]);
    expect(after.scale).toBe(2);
  });

  it("holds the first key before the track starts", () => {
    const track = resolveDeviceTrack(
      doc({ keys: [{ id: "k1", tMs: 400, pose: { d1: { scale: 3 } } }], segments: [] }),
    );
    expect(deviceTrackPoseAt(track, "d1", 0).scale).toBe(3);
  });

  it("holds the resting value for fields a key does not carry", () => {
    const track = resolveDeviceTrack(
      doc({ keys: [{ id: "k1", tMs: 0, pose: { d1: { offset: [0, 1, 0] } } }], segments: [] }),
    );
    const pose = deviceTrackPoseAt(track, "d1", 0);
    expect(pose.scale).toBe(1);
    expect(pose.rotationDeg).toEqual([0, 0, 0]);
  });

  it("takes the device's own lid angle as the resting value", () => {
    const track = resolveDeviceTrack(
      doc({ keys: [{ id: "k1", tMs: 0, pose: { d1: {} } }], segments: [] }),
    );
    expect(deviceTrackPoseAt(track, "d1", 0, 90).lidDeg).toBe(90);
  });

  it("eases a lid that only one end of the segment keys", () => {
    const track = resolveDeviceTrack(
      doc({
        keys: [
          { id: "k1", tMs: 0, pose: { d1: {} } },
          { id: "k2", tMs: 1000, pose: { d1: { lidDeg: 0 } } },
        ],
        segments: [{ from: "k1", to: "k2", ease: "linear" }],
      }),
    );
    expect(deviceTrackPoseAt(track, "d1", 500, 100).lidDeg).toBe(50);
  });

  it("never returns the same array twice, so a caller cannot mutate the track", () => {
    const a = deviceTrackPoseAt(track, "d1", 5000);
    const b = deviceTrackPoseAt(track, "d1", 5000);
    expect(a.offset).not.toBe(b.offset);
    a.offset[0] = 99;
    expect(deviceTrackPoseAt(track, "d1", 5000).offset[0]).toBe(2);
  });
});

describe("deviceTrackPoseIsRest", () => {
  it("recognises a moved pose", () => {
    const track = resolveDeviceTrack(TRACK);
    expect(deviceTrackPoseIsRest(deviceTrackPoseAt(track, "d1", 0))).toBe(true);
    expect(deviceTrackPoseIsRest(deviceTrackPoseAt(track, "d1", 1000))).toBe(false);
  });

  it("compares the lid against the device's own angle", () => {
    const track = resolveDeviceTrack(
      doc({ keys: [{ id: "k1", tMs: 0, pose: { d1: { lidDeg: 90 } } }], segments: [] }),
    );
    expect(deviceTrackPoseIsRest(deviceTrackPoseAt(track, "d1", 0, 90), 90)).toBe(true);
    expect(deviceTrackPoseIsRest(deviceTrackPoseAt(track, "d1", 0, 60), 60)).toBe(false);
  });
});

describe("deviceTrackSnapshotAt", () => {
  it("seeds a key with what every device currently shows", () => {
    const track = resolveDeviceTrack(TRACK);
    const snapshot = deviceTrackSnapshotAt(track, [{ id: "d1" }, { id: "d2" }], 500);
    expect(snapshot.d1).toEqual({ offset: [1, 0.5, 0], rotationDeg: [0, 45, 0], scale: 1.5 });
    expect(snapshot.d2).toEqual({ offset: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 });
  });

  it("writes a lid angle only for a device that has a hinge", () => {
    const snapshot = deviceTrackSnapshotAt(
      null,
      [{ id: "phone" }, { id: "laptop", lidDeg: 90 }],
      0,
    );
    expect(snapshot.phone.lidDeg).toBeUndefined();
    expect(snapshot.laptop.lidDeg).toBe(90);
  });
});

describe("nearestDeviceKey", () => {
  const track = resolveDeviceTrack(
    doc({
      keys: [
        { id: "k1", tMs: 0, pose: {} },
        { id: "k2", tMs: 1000, pose: {} },
        { id: "k3", tMs: 3000, pose: {} },
      ],
      segments: [],
    }),
  );

  it("is null without a track", () => {
    expect(nearestDeviceKey(null, 0)).toBeNull();
  });

  it("takes the key the playhead is closest to, inside or outside a segment", () => {
    expect(nearestDeviceKey(track, 100)?.id).toBe("k1");
    expect(nearestDeviceKey(track, 900)?.id).toBe("k2");
    expect(nearestDeviceKey(track, 2500)?.id).toBe("k3");
    expect(nearestDeviceKey(track, 9000)?.id).toBe("k3");
  });

  it("takes the earlier key on a tie", () => {
    expect(nearestDeviceKey(track, 500)?.id).toBe("k1");
  });
});
