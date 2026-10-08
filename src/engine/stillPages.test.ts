import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chartAnimationEndMs } from "../toolkit/chart/animation";
import { exportFrameTimeMs } from "./exportFrames";
import { FPS } from "./format";
import { derivePresentHold, HOLD_MARGIN_MS } from "./presentHoldPoint";
import type { PresentTimingEntry } from "./presentTimingRegistry";
import { buildSceneCameraTracks } from "./sceneCamera";
import { resolveChart } from "./sceneChart";
import type { SceneDoc, SceneDocCameraKey } from "./sceneDocSchema";
import type { LightingTrack } from "./sceneLighting";
import { buildSceneTimeline, resolveAt, type TimelineSceneInput } from "./sceneTimeline";
import { autoStillLocalMs, planStillPages, type StillPagesInput } from "./stillPages";
import { soloWindow } from "./stills";

const orbitPose = {
  target: [0, 0, 0] as [number, number, number],
  azimuthDeg: 0,
  elevationDeg: 0,
  distance: 5,
};
const key = (id: string, tMs: number, still?: true): SceneDocCameraKey => ({
  id,
  tMs,
  pose: orbitPose,
  ...(still ? { still } : {}),
});
const keyed = <T>(...times: number[]) =>
  ({
    keys: times.map((tMs, i) => ({ id: `k${i}`, tMs, pose: {} })),
    segments: [],
  }) as unknown as T;
const doc = (extra: Partial<SceneDoc> = {}): SceneDoc => ({ version: 1, ...extra });
const text = (toMs: number, extra: Partial<PresentTimingEntry> = {}): PresentTimingEntry => ({
  kind: "text",
  toMs,
  ...extra,
});
const timeline = (...specs: TimelineSceneInput[]) => buildSceneTimeline(specs);
const fade = (durationMs: number) => ({ type: "crossfade" as const, durationMs });
const solo4 = () =>
  timeline(
    { id: "a", durationMs: 4000 },
    { id: "b", durationMs: 4000 },
    { id: "c", durationMs: 4000 },
    { id: "d", durationMs: 4000 },
  );

function plan(
  slots: ReturnType<typeof timeline>,
  docs: (SceneDoc | undefined)[],
  timings: Record<number, PresentTimingEntry[]> = {},
  extra: Partial<StillPagesInput> = {},
) {
  return planStillPages({
    slots,
    sceneDocs: docs,
    timingsFor: (i) => timings[i] ?? [],
    ...extra,
  });
}

/** The settled time an automatic still for scene 0 of a lone 4 s scene lands on. */
function settle(d: SceneDoc | undefined, timings: PresentTimingEntry[] = [], extra = {}) {
  const slots = timeline({ id: "a", durationMs: 4000 });
  return autoStillLocalMs({
    slots,
    index: 0,
    doc: d,
    timings,
    sceneTrack: buildSceneCameraTracks([d])[0],
    ...extra,
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("autoStillLocalMs", () => {
  it("holds where Present does and settles there when nothing else moves", () => {
    const timings = [text(1200), text(800, { staggerSpreadMs: 600 })];
    const auto = settle(doc(), timings);
    expect(auto.holdMs).toBe(derivePresentHold(timings, 4000).holdMs);
    expect(auto.holdMs).toBe(1400 + HOLD_MARGIN_MS);
    expect(auto).toMatchObject({ settledMs: auto.holdMs, basis: "settled" });
  });

  it("runs on to the scene camera's last key", () => {
    const d = doc({ camera: { keys: [key("a", 0), key("b", 2600)], segments: [] } });
    expect(settle(d, [text(600)]).settledMs).toBe(2600);
  });

  it("reads the rig block under rig mode", () => {
    const d = doc({
      cameraMode: "rig",
      camera: { keys: [key("a", 0), key("b", 3500)], segments: [] },
      cameraRig: {
        keys: [
          {
            id: "r1",
            tMs: 0,
            pose: { position: [0, 0, 5], aim: { mode: "point", at: [0, 0, 0] } },
          },
          {
            id: "r2",
            tMs: 1800,
            pose: { position: [1, 0, 5], aim: { mode: "point", at: [0, 0, 0] } },
          },
        ],
        segments: [],
      },
    });
    expect(settle(d, [text(600)]).settledMs).toBe(1800);
  });

  it("counts the device, comparison and chart tracks", () => {
    expect(settle(doc({ deviceTrack: keyed(0, 2100) }), [text(300)]).settledMs).toBe(2100);
    const compare = doc({ compare: { track: keyed(500, 2200) } });
    expect(settle(compare, [text(300)]).settledMs).toBe(2200);
    const chartDoc = doc({
      chart: {
        type: "column",
        data: { categories: ["a", "b", "c"], series: [{ id: "s", values: [1, 2, 3] }] },
        track: { keys: [{ id: "c1", tMs: 2900, pose: { values: [[1, 2, 3]] } }], segments: [] },
      },
    });
    expect(settle(chartDoc).settledMs).toBe(2900);
  });

  it("counts the chart build-in end", () => {
    const chartDoc = doc({
      chart: {
        type: "column",
        data: { categories: ["a", "b", "c", "d"], series: [{ id: "s", values: [1, 2, 3, 4] }] },
      },
    });
    const chart = resolveChart(chartDoc);
    if (!chart) throw new Error("chart expected");
    const end = chartAnimationEndMs(chart.animation, {
      seriesCount: 1,
      categoryCount: 4,
      type: chart.type,
    });
    expect(end).toBeGreaterThan(0);
    expect(settle(chartDoc).settledMs).toBe(end);
  });

  it("counts the layered screenshot animation only while it is the animated track", () => {
    const ls = {
      layers: [],
      pose: {},
      animation: keyed(0, 2700),
    } as unknown as SceneDoc["layeredScreenshot"];
    expect(settle(doc({ layeredScreenshot: ls }), [text(300)]).settledMs).toBe(
      300 + HOLD_MARGIN_MS,
    );
    expect(
      settle(doc({ layeredScreenshot: ls, animatedTrack: "layeredScreenshot" }), [text(300)])
        .settledMs,
    ).toBe(2700);
  });

  it("counts built lighting tracks, which carry animationEnabled", () => {
    const track = keyed<LightingTrack>(0, 3100);
    expect(settle(doc(), [text(300)], { lightingTrack: track }).settledMs).toBe(3100);
    expect(settle(doc(), [text(300)], { compareBLightingTrack: track }).settledMs).toBe(3100);
    expect(settle(doc(), [text(300)], { lightingTrack: null }).settledMs).toBe(
      300 + HOLD_MARGIN_MS,
    );
  });

  it("counts one-shot media motion and ignores looping motion", () => {
    const media = (preset: string, durationMs?: number) =>
      doc({
        media: [
          {
            id: "img-1",
            kind: "image",
            src: "assets/a.png",
            host: "stage",
            stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
            overlay: { position: [0, 0], size: 0.5, rotationDeg: 0 },
            motion: { preset, ...(durationMs ? { durationMs } : {}) },
          },
        ],
      } as unknown as Partial<SceneDoc>);
    expect(settle(media("tilt-reveal")).settledMs).toBe(1000);
    expect(settle(media("push-in", 2400)).settledMs).toBe(2400);
    expect(settle(media("turntable"), [text(300)]).settledMs).toBe(300 + HOLD_MARGIN_MS);
  });

  it("uses the project camera only when the scene has no track of its own", () => {
    const slots = timeline({ id: "a", durationMs: 4000 }, { id: "b", durationMs: 4000 });
    const projectCameraTrack = [
      { tMs: 1000, position: [0, 0, 5] as [number, number, number] },
      { tMs: 6500, position: [1, 0, 5] as [number, number, number] },
    ];
    const base = { slots, timings: [text(300)], projectCameraTrack };
    expect(autoStillLocalMs({ ...base, index: 0, doc: undefined }).settledMs).toBe(4000);
    expect(autoStillLocalMs({ ...base, index: 1, doc: undefined }).settledMs).toBe(2500);
    const tracked = doc({ camera: { keys: [key("a", 0), key("b", 1200)], segments: [] } });
    const sceneTrack = buildSceneCameraTracks([tracked])[0];
    expect(autoStillLocalMs({ ...base, index: 1, doc: tracked, sceneTrack }).settledMs).toBe(1200);
  });

  it("is capped by an authored outro, never below the hold", () => {
    const d = doc({ camera: { keys: [key("a", 0), key("b", 3000)], segments: [] } });
    expect(settle(d, [text(600, { outAtMs: 2000 })]).settledMs).toBe(2000);
    const tight = [text(1500, { outAtMs: 1600 })];
    expect(settle(d, tight)).toMatchObject({ settledMs: 1600, holdMs: 1500 });
    const early = [text(500, { outAtMs: -50 })];
    const hold = derivePresentHold(early, 4000).holdMs;
    expect(settle(d, early)).toMatchObject({ settledMs: hold, holdMs: hold });
  });

  it("is not capped by Present's default leave runway", () => {
    const d = doc({ camera: { keys: [key("a", 0), key("b", 3900)], segments: [] } });
    expect(settle(d, [text(600)]).settledMs).toBe(3900);
  });

  it("falls back to the solo window's centre when nothing registered or keyed", () => {
    expect(settle(doc())).toMatchObject({ settledMs: 2000, basis: "centre" });
    const slots = timeline(
      { id: "a", durationMs: 2000, transition: fade(400) },
      { id: "b", durationMs: 3000 },
    );
    const auto = autoStillLocalMs({ slots, index: 1, doc: undefined, timings: [] });
    expect(auto.settledMs).toBe((400 + 3000) / 2);
  });
});

describe("planStillPages", () => {
  it("lands every page on a frame that renders its scene alone", () => {
    const slots = timeline(
      { id: "a", durationMs: 3000, transition: fade(500) },
      { id: "b", durationMs: 2500, transition: fade(700) },
      { id: "c", durationMs: 3000 },
    );
    const docs = [
      doc({ camera: { keys: [key("a", 0), key("b", 2900)], segments: [] } }),
      doc({ stills: { marksMs: [100, 1200, 2400] } }),
      undefined,
    ];
    const result = plan(slots, docs, { 0: [text(600)] });
    expect(result.pages.length).toBe(5);
    for (const page of result.pages) {
      expect(page.tMs).toBe(exportFrameTimeMs(page.frame, FPS));
      expect(page.resolved.active).toEqual([{ index: page.sceneIndex, localMs: page.sceneMs }]);
      if (page.sceneIndex > 0) expect(page.resolved).toEqual(resolveAt(slots, page.tMs));
    }
    // Scene 0's camera lands inside the outgoing transition: the still renders the scene alone there, never the crossfade.
    expect(result.pages[0].sceneMs).toBeCloseTo(2900, 6);
    expect(result.pages[0].resolved.transition).toBeUndefined();
    expect(resolveAt(slots, result.pages[0].tMs).active).toHaveLength(2);
    expect(result.pages.map((p) => [p.sceneIndex, p.kind, p.ordinal, p.sceneCount])).toEqual([
      [0, "auto", 1, 1],
      [1, "marked", 1, 3],
      [1, "marked", 2, 3],
      [1, "marked", 3, 3],
      [2, "auto", 1, 1],
    ]);
    expect(result.warnings).toEqual([
      { kind: "clamped", sceneIndex: 1, sceneName: "Scene 2", count: 2 },
    ]);
  });

  it("ceils automatic stills and rounds marks onto the frame grid", () => {
    const slots = timeline({ id: "a", durationMs: 4000 });
    const auto = plan(slots, [doc()], { 0: [text(1000)] });
    // 1150 ms is frame 69 exactly; 1160 ms (69.6) ceils to 70.
    expect(auto.pages[0].frame).toBe(69);
    expect(plan(slots, [doc()], { 0: [text(1010)] }).pages[0].frame).toBe(70);
    const marked = plan(slots, [doc({ stills: { marksMs: [1160] } })]);
    expect(marked.pages[0].frame).toBe(70);
    expect(plan(slots, [doc({ stills: { marksMs: [1157] } })]).pages[0].frame).toBe(69);
  });

  it("falls back to a synthetic solo frame when a scene has no solo window", () => {
    const slots = timeline(
      { id: "a", durationMs: 900, transition: fade(400) },
      { id: "b", durationMs: 500, transition: fade(500) },
      { id: "c", durationMs: 800 },
    );
    const result = plan(slots, [undefined, undefined, undefined]);
    const page = result.pages.find((p) => p.sceneIndex === 1);
    expect(page?.resolved).toEqual({ active: [{ index: 1, localMs: page?.sceneMs }] });
    expect(page?.sceneMs).toBeCloseTo(250, 0);
    expect(result.warnings).toContainEqual({
      kind: "empty-solo-window",
      sceneIndex: 1,
      sceneName: "Scene 2",
    });
  });

  it("leaves excluded scenes out entirely and throws when every scene is", () => {
    const slots = solo4();
    const docs = [undefined, doc({ stills: { exclude: true } }), undefined, undefined];
    const result = plan(slots, docs);
    expect(result.pages.map((p) => p.sceneIndex)).toEqual([0, 2, 3]);
    expect(result.bookmarks.map((b) => [b.sceneIndex, b.pageIndex, b.pageCount])).toEqual([
      [0, 0, 1],
      [2, 1, 1],
      [3, 2, 1],
    ]);
    expect(result.holds.has(1)).toBe(false);
    const excluded = doc({ stills: { exclude: true } });
    expect(() => plan(slots, [excluded, excluded, excluded, excluded])).toThrow(/left out/);
  });

  it("holds only automatic-still scenes, at Present's hold", () => {
    const slots = solo4();
    const timings = { 0: [text(900)], 1: [text(900)], 2: [], 3: [text(2000, { outAtMs: 2500 })] };
    const docs = [undefined, doc({ stills: { marksMs: [600] } }), undefined, undefined];
    const result = plan(slots, docs, timings);
    expect([...result.holds.entries()]).toEqual([
      [0, 900 + HOLD_MARGIN_MS],
      [2, derivePresentHold([], 4000).holdMs],
      [3, derivePresentHold(timings[3], 4000).holdMs],
    ]);
    expect(result.pages[1]).toMatchObject({ sceneIndex: 1, kind: "marked" });
    expect(result.pages[2].sceneMs).toBeCloseTo(2000, 0);
  });

  it("falls back to the automatic still when every mark is dormant, with a warning", () => {
    const slots = solo4();
    const docs = [
      doc({
        animatedTrack: "layeredScreenshot",
        camera: { keys: [key("a", 500, true)], segments: [] },
      }),
      doc({
        camera: { keys: [key("a", 500, true)], segments: [] },
        cameraMode: "rig",
        cameraRig: {
          keys: [
            {
              id: "r1",
              tMs: 900,
              still: true,
              pose: { position: [0, 0, 5], aim: { mode: "point", at: [0, 0, 0] } },
            },
          ],
          segments: [],
        },
      }),
      undefined,
      undefined,
    ];
    const result = plan(slots, docs);
    expect(result.pages[0].kind).toBe("auto");
    expect(result.pages[1]).toMatchObject({ kind: "marked", source: { kind: "key", keyId: "r1" } });
    expect(result.warnings).toEqual([
      { kind: "marks-all-dormant", sceneIndex: 0, sceneName: "Scene 1", count: 1 },
      { kind: "dormant-marks", sceneIndex: 1, sceneName: "Scene 2", count: 1 },
    ]);
  });

  it("de-dupes marks by frame and sorts them, a key mark beating a time mark", () => {
    const slots = solo4();
    const docs = [
      doc({
        camera: { keys: [key("a", 0), key("b", 1500, true), key("c", 3000)], segments: [] },
        stills: { marksMs: [2600, 1497, 400] },
      }),
    ];
    const result = plan(slots, [...docs, undefined, undefined, undefined]);
    const scene0 = result.pages.filter((p) => p.sceneIndex === 0);
    expect(scene0.map((p) => p.source?.kind)).toEqual(["time", "key", "time"]);
    expect(scene0.map((p) => p.frame)).toEqual([24, 90, 156]);
  });

  it("names pages from the given names, else Scene N", () => {
    const slots = timeline({ id: "a", durationMs: 2000 }, { id: "b", durationMs: 2000 });
    const result = plan(slots, [doc({ name: "Intro" }), undefined], {}, { sceneNames: ["Hello"] });
    expect(result.pages.map((p) => p.sceneName)).toEqual(["Hello", "Scene 2"]);
    expect(plan(slots, [doc({ name: "Intro" }), undefined]).pages[0].sceneName).toBe("Intro");
  });

  it("keeps a settled still inside the solo window when it fits, and caps it at the scene's end", () => {
    const slots = timeline(
      { id: "a", durationMs: 2000, transition: fade(500) },
      { id: "b", durationMs: 2000 },
    );
    const early = plan(slots, [undefined, undefined], { 0: [text(600)] }).pages[0];
    expect(early.resolved).toEqual(resolveAt(slots, early.tMs));
    expect(early.sceneMs).toBeCloseTo(600 + HOLD_MARGIN_MS, 6);
    const late = plan(slots, [
      doc({ camera: { keys: [key("a", 0), key("b", 9000)], segments: [] } }),
    ]);
    expect(late.pages[0].frame).toBe(Math.ceil(2000 * (FPS / 1000)) - 1);
    expect(late.pages[0].resolved).toEqual({
      active: [{ index: 0, localMs: late.pages[0].sceneMs }],
    });
    const last = plan(slots, [
      undefined,
      doc({ camera: { keys: [key("a", 0), key("b", 9000)], segments: [] } }),
    ]);
    expect(last.pages[1].sceneMs).toBeCloseTo(2000, 6);
    expect(last.pages[1].resolved).toEqual(resolveAt(slots, last.pages[1].tMs));
  });

  it("keeps the centre fallback inside the solo window", () => {
    const slots = timeline(
      { id: "a", durationMs: 2000, transition: fade(500) },
      { id: "b", durationMs: 2000 },
    );
    const page = plan(slots, [undefined, undefined]).pages[1];
    const w = soloWindow(slots, 1);
    expect(page.sceneMs).toBeGreaterThanOrEqual((w.startMs + w.endMs) / 2);
    expect(page.sceneMs - (w.startMs + w.endMs) / 2).toBeLessThan(1000 / FPS);
  });
});
