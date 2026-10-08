import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportFrameTimeMs } from "./exportFrames";
import { FORMATS, FPS } from "./format";
import { buildSceneCameraTracks } from "./sceneCamera";
import type { SceneDoc, SceneDocCameraKey, SceneDocRigKey } from "./sceneDocSchema";
import { buildSceneTimeline, resolveAt, type TimelineSceneInput } from "./sceneTimeline";
import {
  activeCameraBlock,
  addStillMark,
  clampStillMarks,
  removeStillMark,
  STILLS_FPS,
  sceneStillsPlan,
  setKeyStill,
  setStillsExcluded,
  snapStillFrame,
  soloFrameRange,
  soloWindow,
  soloWindowIsEmpty,
  stillsPixelSize,
  stillsSummary,
} from "./stills";

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
const orbit = (...keys: SceneDocCameraKey[]): SceneDoc["camera"] => ({ keys, segments: [] });
const rig = (...keys: SceneDocRigKey[]): SceneDoc["cameraRig"] => ({ keys, segments: [] });
const doc = (extra: Partial<SceneDoc> = {}): SceneDoc => ({ version: 1, ...extra });

const timeline = (...specs: TimelineSceneInput[]) => buildSceneTimeline(specs);
const fade = (durationMs: number) => ({ type: "crossfade" as const, durationMs });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("STILLS_FPS", () => {
  it("mirrors the export frame rate", () => {
    expect(STILLS_FPS).toBe(FPS);
  });
});

describe("activeCameraBlock", () => {
  const docs: (SceneDoc | undefined)[] = [
    undefined,
    doc(),
    doc({ camera: orbit(ok("k1", 0)) }),
    doc({ camera: orbit(ok("k1", 0)), animatedTrack: "layeredScreenshot" }),
    doc({ cameraMode: "rig", cameraRig: rig(rk("r1", 0)) }),
    doc({ cameraMode: "rig", cameraRig: rig(rk("r1", 0)), camera: orbit(ok("k1", 0)) }),
    doc({ cameraMode: "rig", cameraRig: rig(), camera: orbit(ok("k1", 0)) }),
    doc({ cameraMode: "orbit", cameraRig: rig(rk("r1", 0)), camera: orbit(ok("k1", 0)) }),
    doc({ cameraMode: "orbit", cameraRig: rig(rk("r1", 0)) }),
    doc({
      cameraMode: "rig",
      cameraRig: { keys: [{ id: "bad", tMs: 0, pose: { position: [0, 0] } }], segments: [] },
      camera: orbit(ok("k1", 0)),
    } as unknown as Partial<SceneDoc>),
    doc({ camera: { keys: [{ id: "bad", tMs: Number.NaN, pose: orbitPose }], segments: [] } }),
    doc({
      camera: { keys: [{ id: "bad", tMs: 0, pose: { target: [0, 0, 0] } }], segments: [] },
    } as unknown as Partial<SceneDoc>),
    doc({ animatedTrack: "chart", camera: orbit(ok("k1", 400)) }),
  ];

  it("matches buildSceneCameraTracks for every representative doc", () => {
    const tracks = buildSceneCameraTracks(docs);
    docs.forEach((d, i) => {
      const track = tracks[i];
      const expected = track === null ? null : track.mode === "rig" ? "cameraRig" : "camera";
      expect(activeCameraBlock(d), `doc ${i}`).toBe(expected);
    });
  });
});

describe("soloWindow", () => {
  const cases = {
    cuts: timeline(
      { id: "a", durationMs: 900 },
      { id: "b", durationMs: 700 },
      { id: "c", durationMs: 600 },
    ),
    fades: timeline(
      { id: "a", durationMs: 900, transition: fade(250) },
      { id: "b", durationMs: 700, transition: fade(300) },
      { id: "c", durationMs: 600 },
    ),
    consumed: timeline(
      { id: "a", durationMs: 900, transition: fade(400) },
      { id: "b", durationMs: 500, transition: fade(500) },
      { id: "c", durationMs: 800 },
    ),
  };

  for (const [name, slots] of Object.entries(cases)) {
    it(`agrees with resolveAt on every ms (${name})`, () => {
      for (let i = 0; i < slots.length; i++) {
        const w = soloWindow(slots, i);
        for (let local = 0; local <= slots[i].durationMs; local += 0.5) {
          const r = resolveAt(slots, slots[i].startMs + local);
          const solo = r.active.length === 1 && r.active[0].index === i;
          const inside =
            local >= w.startMs && (w.endInclusive ? local <= w.endMs : local < w.endMs);
          expect(inside, `${name} scene ${i} at ${local}`).toBe(solo);
        }
      }
    });
  }

  it("is the transition-trimmed span, inclusive only for the last scene", () => {
    expect(soloWindow(cases.fades, 0)).toEqual({ startMs: 0, endMs: 650, endInclusive: false });
    expect(soloWindow(cases.fades, 1)).toEqual({ startMs: 250, endMs: 400, endInclusive: false });
    expect(soloWindow(cases.fades, 2)).toEqual({ startMs: 300, endMs: 600, endInclusive: true });
    expect(soloWindowIsEmpty(soloWindow(cases.consumed, 1))).toBe(true);
    expect(soloFrameRange(cases.consumed, 1)).toBeNull();
  });
});

describe("soloFrameRange and snapStillFrame", () => {
  const slots = timeline(
    { id: "a", durationMs: 1000, transition: fade(250) },
    { id: "b", durationMs: 1000 },
  );

  it("brackets only frames resolveAt renders as the scene alone", () => {
    for (const i of [0, 1]) {
      const range = soloFrameRange(slots, i);
      expect(range).not.toBeNull();
      if (!range) continue;
      const soloAt = (f: number) => {
        const r = resolveAt(slots, exportFrameTimeMs(f, FPS));
        return r.active.length === 1 && r.active[0].index === i;
      };
      expect(soloAt(range.first)).toBe(true);
      expect(soloAt(range.last)).toBe(true);
      if (i === 0) expect([range.first, soloAt(range.last + 1)]).toEqual([0, false]);
      else expect(soloAt(range.first - 1)).toBe(false);
    }
    // The last scene's last frame is the timeline's final instant.
    expect(exportFrameTimeMs(soloFrameRange(slots, 1)?.last ?? -1, FPS)).toBeCloseTo(1750, 9);
  });

  it("ceils auto stills and rounds marks onto the grid, clamped into the solo window", () => {
    expect(snapStillFrame(slots, 0, 100, FPS, "ceil").frame).toBe(6);
    expect(snapStillFrame(slots, 0, 100, FPS, "round").frame).toBe(6);
    expect(snapStillFrame(slots, 0, 110, FPS, "ceil").frame).toBe(7);
    expect(snapStillFrame(slots, 0, 110, FPS, "round").frame).toBe(7);
    expect(snapStillFrame(slots, 0, 105, FPS, "round").frame).toBe(6);
    const end = snapStillFrame(slots, 0, 900, FPS);
    expect(end.frame).toBe(soloFrameRange(slots, 0)?.last);
    expect(end.solo).toBe(true);
    const start = snapStillFrame(slots, 1, 0, FPS);
    expect(start.frame).toBe(soloFrameRange(slots, 1)?.first);
    expect(start.localMs).toBeGreaterThanOrEqual(250);
  });

  it("snaps within the scene's own span when it has no solo frame", () => {
    const consumed = timeline(
      { id: "a", durationMs: 900, transition: fade(400) },
      { id: "b", durationMs: 500, transition: fade(500) },
      { id: "c", durationMs: 800 },
    );
    const snapped = snapStillFrame(consumed, 1, 250, FPS);
    expect(snapped.solo).toBe(false);
    expect(snapped.localMs).toBeCloseTo(250, 0);
  });
});

describe("sceneStillsPlan", () => {
  const slots = timeline(
    { id: "a", durationMs: 2000, transition: fade(300) },
    { id: "b", durationMs: 2000, transition: fade(300) },
    { id: "c", durationMs: 2000 },
  );

  it("is one automatic still for an unmarked scene, and nothing when left out", () => {
    expect(sceneStillsPlan(undefined, slots, 0)).toEqual({
      included: true,
      stills: [{ kind: "auto" }],
      dormantKeyMarks: 0,
    });
    expect(sceneStillsPlan(doc({ stills: { exclude: true, marksMs: [500] } }), slots, 0)).toEqual({
      included: false,
      stills: [],
      dormantKeyMarks: 0,
    });
  });

  it("uses only active-block key marks and time marks, sorted and snapped", () => {
    const d = doc({
      camera: orbit(ok("k1", 400), ok("k2", 1500, true), ok("k3", 800, true)),
      cameraRig: rig(rk("r1", 600, true)),
      stills: { marksMs: [1200] },
    });
    const plan = sceneStillsPlan(d, slots, 1);
    expect(plan.dormantKeyMarks).toBe(1);
    expect(plan.stills.map((s) => (s.kind === "key" ? s.keyId : s.kind))).toEqual([
      "k3",
      "time",
      "k2",
    ]);
    for (const still of plan.stills) {
      if (still.kind === "auto") continue;
      expect(still.clamped).toBe(false);
      const frame = (slots[1].startMs + still.tMs) * (FPS / 1000);
      expect(Math.abs(frame - Math.round(frame))).toBeLessThan(1e-6);
    }
  });

  it("follows the rig block under rig mode, leaving orbit marks dormant", () => {
    const d = doc({
      cameraMode: "rig",
      camera: orbit(ok("k1", 400, true)),
      cameraRig: rig(rk("r1", 600, true), rk("r2", 1000)),
    });
    const plan = sceneStillsPlan(d, slots, 0);
    expect(plan.dormantKeyMarks).toBe(1);
    expect(plan.stills).toEqual([
      expect.objectContaining({ kind: "key", block: "cameraRig", keyId: "r1", clamped: false }),
    ]);
  });

  it("falls back to its automatic still when every mark is dormant", () => {
    const d = doc({ animatedTrack: "layeredScreenshot", camera: orbit(ok("k1", 400, true)) });
    expect(sceneStillsPlan(d, slots, 0)).toEqual({
      included: true,
      stills: [{ kind: "auto" }],
      dormantKeyMarks: 1,
    });
  });

  it("clamps marks into the solo window and flags them", () => {
    const plan = sceneStillsPlan(doc({ stills: { marksMs: [100, 1900] } }), slots, 1);
    expect(plan.stills).toHaveLength(2);
    const [early, late] = plan.stills as { tMs: number; clamped: boolean }[];
    const w = soloWindow(slots, 1);
    expect(early.clamped).toBe(true);
    expect(early.tMs).toBeGreaterThanOrEqual(w.startMs);
    expect(late.clamped).toBe(true);
    expect(late.tMs).toBeLessThan(w.endMs);
  });

  it("de-dupes marks on one frame, the key mark winning", () => {
    const d = doc({ camera: orbit(ok("k1", 1000, true)), stills: { marksMs: [995, 1004, 1010] } });
    expect(sceneStillsPlan(d, slots, 0).stills).toEqual([
      expect.objectContaining({ kind: "key", keyId: "k1" }),
      expect.objectContaining({ kind: "time", tMs: exportFrameTimeMs(61, FPS) }),
    ]);
  });

  it("drops a clamped mark that lands on another mark's frame", () => {
    const plan = sceneStillsPlan(doc({ stills: { marksMs: [10, 20, 30] } }), slots, 1);
    expect(plan.stills).toHaveLength(1);
  });
});

describe("stillsSummary", () => {
  it("counts pages, marks, exclusions and dormant keys", () => {
    const slots = timeline(
      { id: "a", durationMs: 2000 },
      { id: "b", durationMs: 2000 },
      { id: "c", durationMs: 2000 },
      { id: "d", durationMs: 2000 },
    );
    const docs = [
      undefined,
      doc({ stills: { marksMs: [500, 2500] } }),
      doc({ stills: { exclude: true } }),
      doc({ cameraMode: "rig", camera: orbit(ok("k1", 0, true)), cameraRig: rig(rk("r1", 300)) }),
    ];
    expect(stillsSummary(docs, slots)).toEqual({
      scenes: 4,
      pages: 4,
      auto: 2,
      marked: 2,
      excluded: 1,
      dormantKeyMarks: 1,
      clampedMarks: 1,
    });
  });
});

describe("stillsPixelSize", () => {
  it("scales the short edge and never upscales", () => {
    expect(stillsPixelSize(FORMATS["16:9"], "4k")).toEqual({ width: 3840, height: 2160 });
    expect(stillsPixelSize(FORMATS["16:9"], "1080p")).toEqual({ width: 1920, height: 1080 });
    expect(stillsPixelSize(FORMATS["16:9"], "720p")).toEqual({ width: 1280, height: 720 });
    expect(stillsPixelSize(FORMATS["9:16"], "1080p")).toEqual({ width: 1080, height: 1920 });
    expect(stillsPixelSize(FORMATS["4:5"], "720p")).toEqual({ width: 720, height: 900 });
    expect(stillsPixelSize(FORMATS.phone, "4k")).toEqual({ width: 1206, height: 2622 });
    expect(stillsPixelSize(FORMATS.phone, "1080p")).toEqual({ width: 1080, height: 2348 });
  });
});

describe("stills edit helpers", () => {
  it("toggles exclusion without touching marks, dropping an empty block", () => {
    const d = doc();
    expect(setStillsExcluded(d, false)).toBe(false);
    expect(setStillsExcluded(d, true)).toBeUndefined();
    expect(d.stills).toEqual({ exclude: true });
    expect(setStillsExcluded(d, true)).toBe(false);
    expect(setStillsExcluded(d, false)).toBeUndefined();
    expect(d.stills).toBeUndefined();
    const marked = doc({ stills: { exclude: true, marksMs: [500] } });
    setStillsExcluded(marked, false);
    expect(marked.stills).toEqual({ marksMs: [500] });
  });

  it("adds marks sorted and refuses one within half a frame", () => {
    const d = doc();
    expect(addStillMark(d, 1000.4)).toBeUndefined();
    expect(addStillMark(d, 400)).toBeUndefined();
    expect(d.stills?.marksMs).toEqual([400, 1000]);
    expect(addStillMark(d, 1008)).toBe(false);
    expect(addStillMark(d, 992)).toBe(false);
    expect(addStillMark(d, 1009)).toBeUndefined();
    expect(addStillMark(d, Number.NaN)).toBe(false);
    expect(d.stills?.marksMs).toEqual([400, 1000, 1009]);
  });

  it("removes a mark, dropping the block when it empties", () => {
    const d = doc({ stills: { marksMs: [400, 1000] } });
    expect(removeStillMark(d, 700)).toBe(false);
    expect(removeStillMark(d, 400)).toBeUndefined();
    expect(d.stills).toEqual({ marksMs: [1000] });
    expect(removeStillMark(d, 1000)).toBeUndefined();
    expect(d.stills).toBeUndefined();
    const excluded = doc({ stills: { exclude: true, marksMs: [5] } });
    removeStillMark(excluded, 5);
    expect(excluded.stills).toEqual({ exclude: true });
  });

  it("flags and unflags a key, deleting the field and keeping other fields", () => {
    const track = {
      keys: [ok("k1", 0), ok("k2", 500)],
      segments: [],
      presentLoop: { mode: "jump" as const },
    };
    const on = setKeyStill(track, "k2", true);
    expect(on?.keys[1]).toEqual({ ...ok("k2", 500), still: true });
    expect(on?.presentLoop).toEqual({ mode: "jump" });
    expect(on && setKeyStill(on, "k2", true)).toBe(on);
    const off = on && setKeyStill(on, "k2", false);
    expect(off?.keys[1]).toEqual(ok("k2", 500));
    expect(Object.keys(off?.keys[1] ?? {})).not.toContain("still");
    expect(setKeyStill(track, "nope", true)).toBeNull();
  });

  it("clamps marks to a shorter duration, de-duping, and keeps the block otherwise", () => {
    const stills = { marksMs: [200, 1800, 2500] };
    expect(clampStillMarks(stills, 3000)).toBe(stills);
    expect(clampStillMarks(stills, 1500)).toEqual({ marksMs: [200, 1500] });
    expect(clampStillMarks(undefined, 100)).toBeUndefined();
    const excluded = { exclude: true as const };
    expect(clampStillMarks(excluded, 100)).toBe(excluded);
  });
});
