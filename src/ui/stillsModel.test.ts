import { describe, expect, it } from "vitest";
import type { SceneDoc, SceneDocCameraKey, SceneDocRigKey } from "../engine/sceneDocSchema";
import { buildSceneTimeline } from "../engine/sceneTimeline";
import { sceneStillsPlan } from "../engine/stills";
import {
  dormantStillsHint,
  playheadStillMs,
  rawMarksForTimeStill,
  stillAtFrame,
  stillRows,
  stillsMenuIncludes,
  stillsOverviewValue,
  stillTickTimes,
} from "./stillsModel";

const orbitPose = {
  target: [0, 0, 0] as [number, number, number],
  azimuthDeg: 0,
  elevationDeg: 0,
  distance: 5,
};
const rigPose = {
  position: [0, 0, 5] as [number, number, number],
  aim: { mode: "point" as const, at: [0, 0, 0] as [number, number, number] },
};
const ok = (id: string, tMs: number, still?: true): SceneDocCameraKey => ({
  id,
  tMs,
  pose: orbitPose,
  ...(still ? { still } : {}),
});
const rk = (id: string, tMs: number, still?: true): SceneDocRigKey => ({
  id,
  tMs,
  pose: rigPose,
  ...(still ? { still } : {}),
});
const doc = (extra: Partial<SceneDoc> = {}): SceneDoc => ({ version: 1, ...extra });

// Scene b starts at 1500 under a 500 ms crossfade, so its solo window opens at 500 scene-local.
const slots = buildSceneTimeline([
  { id: "a", durationMs: 2000, transition: { type: "crossfade", durationMs: 500 } },
  { id: "b", durationMs: 2000 },
]);

const marked = doc({
  camera: { keys: [ok("k1", 0), ok("k2", 800, true), ok("k3", 1200)], segments: [] },
  stills: { marksMs: [400] },
});

describe("playheadStillMs", () => {
  it("lands on the global frame under the playhead, as whole scene-local ms", () => {
    expect(playheadStillMs(1010, 0)).toBe(1017);
    expect(playheadStillMs(2010, 1500)).toBe(517);
    expect(playheadStillMs(1490, 1500)).toBe(0);
  });
});

describe("stillRows", () => {
  it("names key stills by time order in their block and time stills as Fixed time", () => {
    const rows = stillRows(sceneStillsPlan(marked, slots, 0), marked);
    expect(rows.map((r) => [r.kind, r.label, r.tMs])).toEqual([
      ["time", "Fixed time", 400],
      ["key", "Camera key 2", 800],
    ]);
    expect(rows[1]).toMatchObject({ keyId: "k2", block: "camera", clamped: false });
  });

  it("shows the automatic still when nothing is marked", () => {
    expect(stillRows(sceneStillsPlan(doc(), slots, 0), doc())).toEqual([
      { id: "auto", kind: "auto", label: "Automatic", tMs: null, clamped: false },
    ]);
  });
});

describe("stillsOverviewValue", () => {
  it("reads Left out, Automatic or the marked count", () => {
    const left = doc({ stills: { exclude: true } });
    expect(stillsOverviewValue(sceneStillsPlan(left, slots, 0))).toBe("Left out");
    expect(stillsOverviewValue(sceneStillsPlan(doc(), slots, 0))).toBe("Automatic");
    expect(stillsOverviewValue(sceneStillsPlan(marked, slots, 0))).toBe("2 marked");
  });
});

describe("dormantStillsHint", () => {
  it("names the idle camera and the one driving the scene", () => {
    const free = doc({
      cameraMode: "rig",
      cameraRig: { keys: [rk("r1", 0)], segments: [] },
      camera: { keys: [ok("k1", 0, true)], segments: [] },
    });
    expect(dormantStillsHint(1, free)).toBe(
      "1 still marked on the orbit camera is ignored while Free drives this scene.",
    );
    const orbit = doc({
      camera: { keys: [ok("k1", 0)], segments: [] },
      cameraRig: { keys: [rk("r1", 0, true), rk("r2", 500, true)], segments: [] },
    });
    expect(dormantStillsHint(2, orbit)).toBe(
      "2 stills marked on the free camera are ignored while Orbit drives this scene.",
    );
    expect(dormantStillsHint(1, doc({ animatedTrack: "layeredScreenshot" }))).toBe(
      "1 still marked on the camera is ignored while the screenshot stack drives this scene.",
    );
    expect(dormantStillsHint(0, orbit)).toBeNull();
  });
});

describe("stillAtFrame", () => {
  it("matches a planned still on the same export frame only", () => {
    const plan = sceneStillsPlan(marked, slots, 0);
    expect(stillAtFrame(plan, slots, 0, 400)).toBe(true);
    expect(stillAtFrame(plan, slots, 0, 405)).toBe(true);
    expect(stillAtFrame(plan, slots, 0, 420)).toBe(false);
    expect(stillAtFrame(plan, slots, 0, 800)).toBe(true);
    expect(stillAtFrame(sceneStillsPlan(doc(), slots, 0), slots, 0, 0)).toBe(false);
  });
});

describe("rawMarksForTimeStill", () => {
  it("finds every raw mark behind a planned time still, clamped edges included", () => {
    const marks = [100, 200, 900];
    const plan = sceneStillsPlan(doc({ stills: { marksMs: marks } }), slots, 1);
    const times = plan.stills.flatMap((s) => (s.kind === "time" ? [s] : []));
    expect(times.map((s) => s.clamped)).toEqual([true, false]);
    expect(rawMarksForTimeStill(marks, times[0].tMs, slots, 1)).toEqual([100, 200]);
    expect(rawMarksForTimeStill(marks, times[1].tMs, slots, 1)).toEqual([900]);
  });
});

describe("stillsMenuIncludes", () => {
  it("offers Include only when every chosen scene is left out", () => {
    const docs = [doc({ stills: { exclude: true } }), doc(), doc({ stills: { exclude: true } })];
    expect(stillsMenuIncludes(docs, [0])).toBe(true);
    expect(stillsMenuIncludes(docs, [0, 2])).toBe(true);
    expect(stillsMenuIncludes(docs, [0, 1])).toBe(false);
    expect(stillsMenuIncludes(docs, [])).toBe(false);
  });
});

describe("stillTickTimes", () => {
  it("places marked stills of included scenes on the global timeline", () => {
    const ticks = stillTickTimes([marked, doc({ stills: { marksMs: [900] } })], slots);
    expect(ticks.map((t) => Math.round(t.ms))).toEqual([400, 800, 2400]);
    expect(new Set(ticks.map((t) => t.id)).size).toBe(3);
    const excluded = doc({ stills: { exclude: true, marksMs: [900] } });
    expect(stillTickTimes([doc(), excluded], slots)).toEqual([]);
  });
});
