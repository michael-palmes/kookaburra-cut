import { describe, expect, it } from "vitest";
import { moveKey } from "./keyedTrack";
import type { ProjectMusic } from "./musicTime";
import { rememberSceneDocHash, sceneDocBase } from "./sceneDocBase";
import {
  detachSceneDocMusic,
  resolveProjectDocsMusic,
  resolveSceneDocMusic,
  sceneMusicScope,
  settleEditedSceneDocMusic,
} from "./sceneDocMusic";
import type { SceneDoc, SceneDocCameraPose } from "./sceneDocSchema";

// 120 BPM in 4/4 with bar 1 at 250 ms: a beat is 500 ms, a bar 2000 ms, bar N starts at 250 + (N - 1) * 2000.
const music = (over: Partial<ProjectMusic> = {}): ProjectMusic => ({
  grid: { bpm: 120, offsetMs: 250, beatsPerBar: 4 },
  startOffsetMs: 0,
  cues: { drop: "bar:5" },
  sections: {},
  ...over,
});

const pose: SceneDocCameraPose = {
  target: [0, 0, 0],
  azimuthDeg: 0,
  elevationDeg: 10,
  distance: 6,
};

function docWith(keys: { id: string; tMs: number; at?: string }[]): SceneDoc {
  return {
    version: 1,
    camera: {
      keys: keys.map((k) => ({ ...k, pose })),
      segments: [{ from: keys[0].id, to: keys[keys.length - 1].id, ease: "inOutQuad" }],
    },
  };
}

describe("resolveSceneDocMusic", () => {
  it("returns the same doc when nothing carries a position", () => {
    const doc = docWith([
      { id: "k1", tMs: 0 },
      { id: "k2", tMs: 3000 },
    ]);
    expect(resolveSceneDocMusic(doc, music(), 0).doc).toBe(doc);
    expect(resolveSceneDocMusic(doc, undefined, 0).doc).toBe(doc);
    const docs = [doc, undefined];
    expect(resolveProjectDocsMusic(docs, undefined, [{ startMs: 0 }, { startMs: 1 }]).docs).toBe(
      docs,
    );
  });

  it("returns the same doc when every cache already matches", () => {
    const doc = docWith([
      { id: "k1", tMs: 0 },
      { id: "k2", tMs: 8250, at: "bar:5" },
    ]);
    expect(resolveSceneDocMusic(doc, music(), 0).doc).toBe(doc);
  });

  it("sets tMs from at in scene-local integer ms on camera, rig and lighting keys", () => {
    const doc: SceneDoc = {
      ...docWith([
        { id: "k1", tMs: 0 },
        { id: "k2", tMs: 1, at: "bar:5" },
      ]),
      cameraRig: {
        keys: [
          {
            id: "r1",
            tMs: 1,
            at: "cue:drop",
            pose: { position: [0, 0, 5], aim: { mode: "point", at: [0, 0, 0] } },
          },
        ],
        segments: [],
      },
      lighting: { keys: [{ id: "l1", tMs: 1, at: "bar:2.3", pose: { ambient: 1 } }] },
      compare: { b: { lighting: { keys: [{ id: "b1", tMs: 1, at: "bar:3", pose: {} }] } } },
    };
    const { doc: out, issues } = resolveSceneDocMusic(doc, music(), 1000);
    expect(issues).toEqual([]);
    expect(out.camera?.keys.map((k) => k.tMs)).toEqual([0, 7250]);
    expect(out.cameraRig?.keys[0].tMs).toBe(7250);
    expect(out.lighting?.keys?.[0].tMs).toBe(2250);
    expect(out.compare?.b?.lighting?.keys?.[0].tMs).toBe(3250);
    expect(out.camera?.keys[1].at).toBe("bar:5");
    expect(doc.camera?.keys[1].tMs).toBe(1);
  });

  it("rounds once, after the slot shift", () => {
    const odd = music({ grid: { bpm: 135.11, offsetMs: 101.7, beatsPerBar: 4 } });
    const doc = docWith([{ id: "k1", tMs: 0, at: "bar:3.2.3" }]);
    const projectMs = 101.7 + (2 * 4 + 1 + 0.5) * (60000 / 135.11);
    const out = resolveSceneDocMusic(doc, odd, 333).doc;
    expect(out.camera?.keys[0].tMs).toBe(Math.round(projectMs - 333));
  });

  it("keeps the stored time and reports once when a position can't resolve", () => {
    const doc = docWith([
      { id: "k1", tMs: 1200, at: "bar:5" },
      { id: "k2", tMs: 2400, at: "cue:nowhere" },
    ]);
    const noGrid = resolveSceneDocMusic(doc, undefined, 0);
    expect(noGrid.doc).toBe(doc);
    expect(noGrid.issues).toHaveLength(2);
    expect(noGrid.issues[0]).toContain('camera key "k1" "bar:5"');
    expect(resolveSceneDocMusic(doc, music(), 0).issues).toEqual([
      'camera key "k2" "cue:nowhere": no cue "nowhere"',
    ]);
  });

  it("carries the disk hash to a resolved doc so its next write is checked like the original", () => {
    const doc = docWith([{ id: "k1", tMs: 0, at: "bar:2" }]);
    rememberSceneDocHash(doc, "hash-1");
    const out = resolveSceneDocMusic(doc, music(), 0).doc;
    expect(out).not.toBe(doc);
    expect(sceneDocBase(out)).toBe("hash-1");
  });
});

describe("the detach rule", () => {
  const resolved = () =>
    resolveSceneDocMusic(
      docWith([
        { id: "k1", tMs: 0 },
        { id: "k2", tMs: 0, at: "bar:5" },
        { id: "k3", tMs: 0, at: "bar:7" },
      ]),
      music(),
      0,
    ).doc;

  it("an edit that moves a key drops its at, and the move survives resolution", () => {
    const doc = resolved();
    const camera = doc.camera;
    if (!camera) throw new Error("no camera");
    const moved = moveKey(camera, "k2", 9000, 20000);
    if (!moved) throw new Error("no move");
    expect(moved.keys[1]).toMatchObject({ tMs: 9000, at: "bar:5" });
    const settled = settleEditedSceneDocMusic({ ...doc, camera: moved }, music(), 0);
    expect(settled.camera?.keys[1].tMs).toBe(9000);
    expect(settled.camera?.keys[1].at).toBeUndefined();
    expect(settled.camera?.keys[2]).toMatchObject({ tMs: 12250, at: "bar:7" });
  });

  it("an edit that leaves every key alone returns the same doc", () => {
    const doc = resolved();
    expect(settleEditedSceneDocMusic(doc, music(), 0)).toBe(doc);
    expect(detachSceneDocMusic(doc, music(), 0)).toBe(doc);
  });

  it("an unresolvable at survives a detach with both values", () => {
    const doc = docWith([{ id: "k1", tMs: 4321, at: "bar:5" }]);
    expect(detachSceneDocMusic(doc, undefined, 0)).toBe(doc);
  });

  it("a grid change only resolves: every key follows the music and keeps its at", () => {
    const doc = resolved();
    const slower = music({ grid: { bpm: 60, offsetMs: 250, beatsPerBar: 4 } });
    const out = resolveSceneDocMusic(doc, slower, 0).doc;
    expect(out.camera?.keys.map((k) => [k.tMs, k.at])).toEqual([
      [0, undefined],
      [16250, "bar:5"],
      [24250, "bar:7"],
    ]);
  });

  it("a slot move (an earlier scene's length changed) keeps at and shifts the cache", () => {
    const docs = [undefined, resolved()];
    const before = [{ startMs: 0 }, { startMs: 0 }];
    const after = [{ startMs: 0 }, { startMs: 2000 }];
    expect(resolveProjectDocsMusic(docs, music(), before).changed).toEqual([]);
    const r = resolveProjectDocsMusic(docs, music(), after);
    expect(r.changed).toEqual([1]);
    expect(r.docs[1]?.camera?.keys.map((k) => [k.tMs, k.at])).toEqual([
      [0, undefined],
      [6250, "bar:5"],
      [10250, "bar:7"],
    ]);
    // The edit path under the new slot leaves the re-resolved doc alone.
    const moved = r.docs[1];
    if (!moved) throw new Error("no doc");
    expect(settleEditedSceneDocMusic(moved, music(), 2000)).toBe(moved);
  });

  it("scopes a scene by its slot start", () => {
    expect(
      sceneMusicScope({ music: music(), slots: [{ startMs: 0 }, { startMs: 900 }] }, 1),
    ).toEqual({ music: music(), sceneStartMs: 900 });
  });
});
