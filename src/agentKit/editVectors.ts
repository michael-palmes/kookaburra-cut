/** Conformance vectors for kb video's Python mirror of the editor maths (kblib/video/editmath.py, editops.py): every editMath/editMasks export on hand-picked edge cases, then edit ops (one hand vector per op covering each error code, plus seeded random sequences) recorded step by step with the final doc. `editVectors.test.ts` writes them under KB_WRITE_VECTORS=1 and fails when the committed file is stale. Contract: docs/agent-kit.md ("Conformance vectors"). */

import type { EditClip, EditDoc, EditMask, EditSource, EditTap } from "../engine/edit";
import * as masks from "../engine/editMasks";
import * as math from "../engine/editMath";
import { applyEditOp, type EditOp, MASK_STYLES, type SourceMeta } from "../engine/editOps";

export const EDIT_VECTORS_VERSION = 1;
export const RANDOM_SEQUENCES = 100;

export interface FnVector {
  fn: string;
  args: unknown[];
  out: unknown;
}

export interface OpStep {
  op: EditOp;
  ok: boolean;
  code?: string;
}

export interface OpVector {
  id: string;
  doc: EditDoc;
  steps: OpStep[];
  final: EditDoc;
}

export interface EditVectors {
  version: number;
  constants: Record<string, number | string>;
  fns: FnVector[];
  ops: OpVector[];
}

/** mulberry32: a tiny seeded PRNG, so the random sequences are the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Hand-picked function cases ────────────────────────────────────────────────

const clip = (
  id: string,
  inMs: number,
  outMs: number,
  speed = 1,
  extra: Partial<EditClip> = {},
): EditClip => ({ id, sourceId: "s1", inMs, outMs, speed, startMs: 0, ...extra });
const hold = (id: string, atMs: number, holdMs: number, sourceId = "s1"): EditClip =>
  clip(id, atMs, atMs, 1, { holdMs, sourceId });

const HALVES = math.relayout([
  clip("c1", 0, 1001, 2),
  clip("c2", 1001, 2002, 2),
  clip("c3", 0, 1001, 2),
]);
const MIXED = math.relayout([
  clip("c1", 0, 4000),
  hold("c2", 4000, 1000),
  clip("c3", 6000, 9000, 2),
  clip("c4", 0, 1000, 0.75),
  hold("c5", 0, 2000, "s2"),
]);
const TRIO = MIXED.slice(0, 3);
const SHORT = math.relayout([clip("c1", 1000, 1150)]);
const VIDEO: EditSource = {
  id: "s1",
  rel: "assets/a.mp4",
  kind: "video",
  width: 1170,
  height: 2532,
  fps: 60,
  durationMs: 12000,
};
const VIDEO_META: SourceMeta = {
  rel: "assets/a.mp4",
  kind: "video",
  width: 1170,
  height: 2532,
  fps: 60,
  durationMs: 12000,
};
const IMAGE: EditSource = {
  id: "s2",
  rel: "assets/b.png",
  kind: "image",
  width: 1920,
  height: 1080,
  fps: 0,
  durationMs: 0,
};
const KEYED: EditMask = {
  id: "m1",
  sourceId: "s1",
  style: "blur",
  startMs: 1000,
  endMs: 3000,
  keys: [
    { sourceMs: 1000, rect: [0.1, 0.1, 0.3, 0.1] },
    { sourceMs: 2000, rect: [0.2, 0.3, 0.4, 0.2] },
  ],
};
const STILL_MASK: EditMask = {
  id: "m2",
  sourceId: "s2",
  style: "solid",
  startMs: 0,
  endMs: 0,
  keys: [{ sourceMs: 0, rect: [0.4, 0.4, 0.2, 0.2] }],
};
const TAP: EditTap = { id: "t1", sourceId: "s1", sourceMs: 1500, pos: [0.5, 0.4] };
const FADED: EditMask = { ...KEYED, fadeInMs: 250, fadeOutMs: 400 };
const CROPPED = math.relayout([
  clip("c1", 0, 4000, 1, { crop: [0.1, 0.1, 0.5, 0.5] }),
  hold("c2", 4000, 1000),
  clip("c3", 6000, 9000, 2),
]);
const ODD = { width: 1179, height: 2556 };
const QUAD: [number, number, number, number] = [0.25, 0.25, 0.5, 0.5];

/** Every exported function with its cases; Map arguments and results are written as plain objects. */
function fnCases(): FnVector[] {
  const cases: [string, unknown[]][] = [];
  const add = (fn: string, ...argSets: unknown[][]) => {
    for (const args of argSets) cases.push([fn, args]);
  };
  add(
    "clipTimelineMs",
    [clip("c1", 0, 1000)],
    [clip("c1", 0, 1001, 2)],
    [clip("c1", 0, 1000, 0)],
    [clip("c1", 0, 1000, -1)],
    [clip("c1", 0, 1000, 0.75)],
    [hold("c1", 500, 1500)],
    [hold("c1", 500, 0)],
    [clip("c1", 900, 500)],
  );
  add(
    "relayout",
    [[clip("c1", 0, 1001, 2), clip("c2", 1001, 2002, 2), clip("c3", 0, 1001, 2)]],
    [[clip("c1", 0, 1000, 0.75), clip("c2", 0, 1000, 0.75), hold("c3", 0, 333)]],
    [[clip("c1", 0, 999, 4), clip("c2", 0, 1, 6), clip("c3", 0, 1000, 0)]],
    [[]],
  );
  add("timelineDurationMs", [HALVES], [MIXED], [[]]);
  add(
    "clipIndexAt",
    [TRIO, 0],
    [TRIO, 3999.9],
    [TRIO, 4000],
    [TRIO, -1],
    [TRIO, 6500],
    [TRIO, 99999],
    [[], 0],
  );
  add(
    "timelineToSource",
    [MIXED[0], 2500.5],
    [MIXED[0], -10],
    [MIXED[0], 5000],
    [MIXED[1], 4500],
    [MIXED[2], 5250.25],
    [MIXED[3], 6600],
  );
  add(
    "splitAt",
    [TRIO, 1000.25, "c9"],
    [HALVES, 250.25, "c9"],
    [TRIO, 50, "c9"],
    [TRIO, 3950, "c9"],
    [TRIO, 4500, "c9"],
    [TRIO, 5000.5, "c9"],
  );
  add("removeClip", [TRIO, "c3"], [TRIO, "c9"]);
  add("moveClip", [TRIO, 9, 0], [TRIO, 0, 10], [TRIO, 2, -3]);
  add("setClipSpeed", [TRIO, "c1", 1.35], [TRIO, "c1", 0], [TRIO, "c1", -2], [TRIO, "c2", 2]);
  add(
    "trimClipIn",
    [TRIO, "c1", 500.5],
    [TRIO, "c1", 3950],
    [TRIO, "c1", -40],
    [TRIO, "c2", 10],
    [SHORT, "c1", 1400],
  );
  add(
    "trimClipOut",
    [TRIO, "c3", 13000, 12000],
    [TRIO, "c1", 50, 12000],
    [TRIO, "c1", 2500.5, 12000],
    [TRIO, "c2", 9000, 12000],
    [TRIO, "c1", 2000, 0],
  );
  add("imageClip", [TRIO, "s2", 50], [TRIO, "s2", 2000], [TRIO, "s2", 1234.5], [[], "s2", 2000]);
  add(
    "freezeAt",
    [TRIO, 2000, 2000],
    [TRIO, 40, 2000],
    [TRIO, 3960, 2000],
    [TRIO, 4500, 2000],
    [TRIO, 5250.5, 50],
    [HALVES, 250.25, 1234.5],
    [CROPPED, 2000, 2000],
    [CROPPED, 40, 2000],
  );
  add(
    "freezeAtEnd",
    [TRIO, 60, 2000],
    [TRIO, 0, 2000],
    [TRIO.slice(0, 1), 30, 1500],
    [TRIO.slice(0, 1), 29.97, 1500],
    [TRIO.slice(0, 2), 60, 2000],
    [[], 60, 2000],
    [CROPPED.slice(0, 1), 60, 1500],
  );
  add(
    "insertClipAt",
    [TRIO, 2000, clip("c9", 0, 500)],
    [TRIO, 4200, clip("c9", 0, 500)],
    [TRIO, 4800, clip("c9", 0, 500)],
    [TRIO, 3960, clip("c9", 0, 500)],
    [SHORT, 75, clip("c9", 0, 500)],
    [SHORT, 74, clip("c9", 0, 500)],
    [TRIO, 99999, clip("c9", 0, 500)],
  );
  add("setClipHold", [TRIO, "c2", 50], [TRIO, "c2", 2500.4], [TRIO, "c1", 2500]);
  add("edgeTargetsMs", [MIXED], [HALVES], [[]]);
  add(
    "snapMs",
    [1005, [0, 1000, 2000], 8],
    [1004, [1000, 1008], 8],
    [1050, [0, 1000], 8],
    [0, [], 8],
  );
  add(
    "nextPrefixedId",
    ["c", ["c1", "c2"]],
    ["c", ["c1", "c3"]],
    ["c", []],
    ["c", ["c01", "cx", "c"]],
    ["t", ["t2", "t3", "c9"]],
    ["c", ["c١", "c2"]],
    ["m", ["m1.5", "m-2", "m 3"]],
  );
  add("nextClipId", [MIXED]);
  add("nextSourceId", [[VIDEO, IMAGE]]);
  add("nextTapId", [[TAP]], [[]]);
  add("nextMaskId", [[KEYED, STILL_MASK]]);
  add("outputToSource", [TRIO, 2500.5], [TRIO, 4500], [TRIO, 99999], [TRIO, 5250.25], [TRIO, -1]);
  add(
    "tapWindows",
    [TRIO, TAP, 550],
    [math.relayout([clip("c1", 0, 2000), clip("c2", 1000, 2000)]), TAP, 550],
    [math.relayout([clip("c1", 0, 1700), clip("c2", 0, 500)]), TAP, 550],
    [math.relayout([clip("c1", 0, 1500)]), TAP, 550],
    [math.relayout([hold("c1", 1500, 1000)]), TAP, 550],
    [TRIO, { ...TAP, sourceId: "s2" }, 550],
    [math.relayout([clip("c1", 1000, 3000, 0.25)]), TAP, 550],
    [math.relayout([clip("c1", 0, 2000, 1, { crop: [0.6, 0, 0.4, 0.5] })]), TAP, 550],
    [math.relayout([clip("c1", 0, 2000, 1, { crop: QUAD })]), TAP, 550],
  );
  add("addTap", [[TAP], { ...TAP, id: "t2" }]);
  add("moveTap", [[TAP], "t1", [0.1, 0.9]], [[TAP], "t9", [0.1, 0.9]]);
  add("retimeTap", [[TAP], "t1", "s3", 250]);
  add("removeTap", [[TAP], "t1"], [[TAP], "t9"]);
  add(
    "cropPixels",
    [[0.1, 0.2, 0.5, 0.25], VIDEO],
    [[0, 0, 1, 1], ODD],
    [[0.99, 0.99, 0.5, 0.5], VIDEO],
    [[-0.2, 0.5, 0.001, 2], VIDEO],
    [QUAD, { width: 0, height: 0 }],
    [[0.3333, 0.3333, 0.3333, 0.3333], { width: 333, height: 777 }],
    [[0.5, 0.5, 0.5, 0.5], { width: 1, height: 1 }],
  );
  add(
    "snapCropRect",
    [[0.1, 0.2, 0.5, 0.25], VIDEO],
    [[0.9, 0.9, 0.5, 0.5], VIDEO],
    [[0, 0, 0.001, 0.001], VIDEO],
    [[-1, -1, 3, 3], ODD],
    [[0.3333, 0.1, 0.3333, 0.2], { width: 333, height: 777 }],
  );
  add(
    "aspectCropRect",
    [VIDEO, 1080 / 1920],
    [VIDEO, 16 / 9],
    [IMAGE, 9 / 16],
    [IMAGE, 9 / 16, [0.1, 0.5]],
    [IMAGE, 9 / 16, [0.95, 0.2]],
    [ODD, 1],
  );
  add(
    "posInCrop",
    [[0.5, 0.5], QUAD],
    [[0.25, 0.25], QUAD],
    [[0.75, 0.75], QUAD],
    [[0.76, 0.5], QUAD],
    [[0.1, 0.9], QUAD],
  );
  add(
    "tapPosInCrop",
    [[0.5, 0.4], QUAD, VIDEO],
    [[0.1, 0.1], QUAD, VIDEO],
    [[0.75, 0.75], QUAD, ODD],
    [[0.3, 0.3], [0.2, 0.2, 0.4, 0.4], { width: 333, height: 777 }],
  );
  add(
    "setClipCrop",
    [TRIO, "c1", [0.1, 0.1, 0.5, 0.5]],
    [CROPPED, "c1", null],
    [TRIO, "c9", [0, 0, 1, 1]],
    [TRIO, "c2", [0.2, 0.2, 0.4, 0.4]],
  );

  add(
    "maskBlurSigmaPx",
    [{}, VIDEO],
    [{ strength: 0 }, VIDEO],
    [{ strength: 1 }, IMAGE],
    [{ strength: 2 }, VIDEO],
    [{ strength: -1 }, IMAGE],
    [{ strength: 0.37 }, { width: 333, height: 777 }],
  );
  add(
    "maskBlockPx",
    [{}, VIDEO],
    [{ strength: 0 }, VIDEO],
    [{ strength: 1 }, IMAGE],
    [{ strength: 0.5 }, { width: 10, height: 10 }],
    [{ strength: 0.37 }, { width: 333, height: 777 }],
  );
  add(
    "clampRect",
    [[0.1, 0.2, 0.3, 0.4]],
    [[-0.5, 1.2, 2, 0.001]],
    [[0.9, 0.9, 0.5, 0.5]],
    [[0, 0, 0, 0]],
  );
  add(
    "rectFromCorners",
    [
      [0.6, 0.7],
      [0.2, 0.1],
    ],
    [
      [-0.2, 0.5],
      [1.4, 0.505],
    ],
    [
      [0.3, 0.3],
      [0.3, 0.3],
    ],
  );
  add(
    "defaultMaskRect",
    [[0.5, 0.5], VIDEO],
    [[0.02, 0.98], IMAGE],
    [[0.5, 0.5], { width: 0, height: 0 }],
  );
  add(
    "sampleMaskRect",
    [[], 100],
    [KEYED.keys, 500],
    [KEYED.keys, 1000],
    [KEYED.keys, 1250],
    [KEYED.keys, 1999],
    [KEYED.keys, 5000],
  );
  add(
    "sourceMomentAt",
    [[], 0],
    [TRIO, 2500.5],
    [MIXED, 99999],
    [TRIO, 4500],
    [TRIO, 5250.25],
    [MIXED, 9833.333333333334],
  );
  add(
    "maskActiveAt",
    [KEYED, 1000, false],
    [KEYED, 3000, false],
    [KEYED, 2999, false],
    [KEYED, 10, true],
  );
  add(
    "maskOpacityAt",
    [FADED, 999, false],
    [FADED, 1000, false],
    [FADED, 1100, false],
    [FADED, 1250, false],
    [FADED, 2000, false],
    [FADED, 2900, false],
    [FADED, 2999, false],
    [FADED, 3000, false],
    [KEYED, 1500, false],
    [STILL_MASK, 0, true],
    [{ ...KEYED, fadeOutMs: 500 }, 2750, false],
  );
  add("withMaskFades", [KEYED, 250.5, 0], [FADED, 0, 0], [FADED, -5, 120.4], [KEYED, 1999.5, 0.5]);
  const twoCuts = math.relayout([
    clip("c1", 0, 1500),
    hold("c2", 2000, 700),
    clip("c3", 1500, 4000, 2),
  ]);
  add(
    "maskWindows",
    [twoCuts, KEYED, false],
    [TRIO, KEYED, false],
    [MIXED, STILL_MASK, true],
    [TRIO, { ...KEYED, startMs: 9000, endMs: 9500 }, false],
    [math.relayout([hold("c1", 3000, 500)]), KEYED, false],
  );
  add("packMaskRows", [
    {
      m1: masks.maskWindows(twoCuts, KEYED, false),
      m2: masks.maskWindows(twoCuts, { ...KEYED, id: "m2", startMs: 2500, endMs: 3500 }, false),
      m3: masks.maskWindows(twoCuts, { ...KEYED, id: "m3", startMs: 3600, endMs: 3900 }, false),
      m4: [],
    },
  ]);
  add(
    "pruneOrphanMasks",
    [MIXED, [KEYED, STILL_MASK], [VIDEO, IMAGE]],
    [MIXED, [{ ...KEYED, startMs: 9000, endMs: 9500 }, STILL_MASK], [VIDEO, IMAGE]],
    [MIXED, [KEYED, STILL_MASK], [VIDEO]],
  );
  const moment = (t: number, clips = MIXED) => masks.sourceMomentAt(clips, t);
  add(
    "defaultMaskRange",
    [moment(1000), VIDEO],
    [moment(5250.25), VIDEO],
    [moment(5250.25), { durationMs: 7000 }],
    [moment(1000), { durationMs: 0 }],
    [moment(4500), VIDEO],
    [moment(3990), { durationMs: 4000 }],
  );
  add("keyToleranceMs", [60, 1], [0, 1], [30, 2], [60, 0], [29.97, 0.75]);
  add(
    "keyIndexAt",
    [KEYED.keys, 1000, 8.3],
    [KEYED.keys, 1008, 8.333333333333334],
    [KEYED.keys, 1500, 600],
    [KEYED.keys, 1500, 8],
  );
  add(
    "upsertMaskKey",
    [KEYED, 1004, [0.5, 0.5, 0.2, 0.2], 8.333333333333334, false],
    [KEYED, 1500.5, [0.5, 0.5, 0.2, 0.2], 8.333333333333334, false],
    [KEYED, -20, [0.5, 0.5, 2, 0.2], 8.333333333333334, false],
    [STILL_MASK, 700, [0.1, 0.1, 0.1, 0.1], 8.333333333333334, true],
  );
  add(
    "addHoldKey",
    [KEYED, 1500, 8.333333333333334],
    [KEYED, 2000, 8.333333333333334],
    [{ ...KEYED, keys: [] }, 1500, 8],
  );
  add(
    "removeMaskKey",
    [KEYED, 2004, 8.333333333333334],
    [KEYED, 1500, 8.333333333333334],
    [STILL_MASK, 0, 8.333333333333334],
  );
  add(
    "offsetMaskKeys",
    [KEYED, 0.5, -0.5],
    [KEYED, 0.05, 0.05],
    [{ ...KEYED, keys: [] }, 0.1, 0.1],
  );
  add("timelineToSourceUnclamped", [MIXED[0], 5000], [MIXED[1], 4800], [MIXED[2], 7000.25]);
  add(
    "retimeMaskEdge",
    [KEYED, "start", 2950, 12000],
    [KEYED, "start", -100, 12000],
    [KEYED, "end", 20000, 12000],
    [KEYED, "end", 20000, 0],
    [KEYED, "end", 1050.5, 12000],
    [FADED, "start", 2500, 12000],
    [FADED, "end", 1300, 12000],
    [FADED, "end", 1100, 12000],
    [FADED, "start", 1500, 12000],
    [{ ...KEYED, fadeInMs: 1900 }, "start", 1500, 12000],
  );
  add("replaceMask", [[KEYED, STILL_MASK], { ...STILL_MASK, style: "blur" }]);

  const table = { ...math, ...masks } as unknown as Record<string, (...a: unknown[]) => unknown>;
  return cases.map(([fn, args]) => {
    const call = args.map((a) =>
      fn === "packMaskRows" ? new Map(Object.entries(a as Record<string, unknown>)) : a,
    );
    const raw = table[fn](...call);
    const out = raw instanceof Map ? Object.fromEntries(raw) : raw;
    return { fn, args, out: out === undefined ? null : out };
  });
}

/** Every exported function of editMath and editMasks, so a new export without a case fails the test. */
export function exportedEditFunctions(): string[] {
  return Object.entries({ ...math, ...masks })
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k)
    .sort();
}

function constants(): Record<string, number | string> {
  return Object.fromEntries(
    Object.entries({ ...math, ...masks }).filter(
      ([, v]) => typeof v === "number" || typeof v === "string",
    ),
  ) as Record<string, number | string>;
}

// ── Op vectors ────────────────────────────────────────────────────────────────

function runSteps(id: string, doc: EditDoc, ops: EditOp[]): OpVector {
  let current = doc;
  const steps = ops.map((op): OpStep => {
    const result = applyEditOp(current, op);
    if (result.ok) {
      current = result.doc;
      return { op, ok: true };
    }
    return { op, ok: false, code: result.code };
  });
  return { id, doc, steps, final: current };
}

const HAND_DOC: EditDoc = {
  version: 2,
  name: "vectors",
  sources: [VIDEO, IMAGE],
  settings: { width: 1170, height: 2532, fps: 60 },
  clips: math.relayout([
    clip("c1", 0, 4000),
    hold("c2", 4000, 1000),
    clip("c3", 6000, 9000, 2),
    hold("c4", 0, 2000, "s2"),
  ]),
  taps: [TAP],
  masks: [KEYED, STILL_MASK],
};

const newVideo = {
  rel: "assets/c.mp4",
  kind: "video",
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 3000,
} as const;
const newImage = {
  rel: "assets/d.png",
  kind: "image",
  width: 800,
  height: 600,
  fps: 0,
  durationMs: 0,
} as const;
const bad = <T>(op: unknown) => op as T;

/** Hand vectors by op family: each op's refusals first (they leave the doc alone), then its successes, so every op and every error code appears. HAND_DOC's timeline: c1 0-4000, freeze c2 4000-5000, c3 at 2x 5000-6500, still c4 6500-8500. */
function handVectors(): OpVector[] {
  const noClips: EditDoc = { ...HAND_DOC, clips: [], taps: [], masks: [KEYED] };
  const dangling: EditDoc = {
    ...HAND_DOC,
    clips: math.relayout([{ ...clip("c1", 0, 2000), sourceId: "s9" }]),
    masks: [],
  };
  const lastVideo: EditDoc = {
    ...HAND_DOC,
    settings: { ...HAND_DOC.settings, fps: 0 },
    clips: HAND_DOC.clips.slice(0, 3),
  };
  const sizeless: EditDoc = {
    ...HAND_DOC,
    sources: [{ ...VIDEO, width: 1, height: 0 }, IMAGE],
    clips: math.relayout([clip("c1", 0, 2000), { ...clip("c2", 0, 1000), sourceId: "s9" }]),
    taps: [],
    masks: [],
  };
  const v = (id: string, ops: EditOp[], doc = HAND_DOC) => runSteps(`hand/${id}`, doc, ops);
  return [
    v("add-clips", [
      bad({ op: "addClip", source: { ...newVideo, kind: "audio" } }),
      bad({ op: "addClip", source: { ...newVideo, durationMs: 10.5 } }),
      { op: "addClip", source: newVideo, index: 1.5 },
      { op: "addClip", source: newVideo },
      { op: "addClip", source: VIDEO_META, index: 0 },
      { op: "addClip", source: newImage, index: -4 },
      { op: "addClip", source: newImage, index: 99 },
      bad({ op: "insertClip", source: newVideo }),
      { op: "insertClip", source: newVideo, atMs: 6000.5 },
      { op: "insertClip", source: newImage, atMs: 6200 },
      { op: "insertClip", source: newImage, atMs: 7300 },
      { op: "insertClip", source: VIDEO_META, atMs: 99999 },
    ]),
    v("split-freeze", [
      bad({ op: "split", atMs: "1s" }),
      { op: "split", atMs: 99999 },
      { op: "split", atMs: 4500 },
      { op: "split", atMs: 50 },
      { op: "split", atMs: 7000 },
      { op: "split", atMs: 1000.25 },
      { op: "split", atMs: 5600.75 },
      { op: "freeze", atMs: 2000, holdMs: 0 },
      { op: "freeze", atMs: 9000 },
      { op: "freeze", atMs: 4500 },
      { op: "freeze", atMs: 8500 },
      { op: "freeze", atMs: 2000.4, holdMs: 1500 },
      { op: "freeze", atMs: 30 },
    ]),
    v(
      "freeze-end",
      [
        { op: "freeze", atMs: 6495 },
        { op: "freeze", atMs: 8500 },
      ],
      lastVideo,
    ),
    v(
      "no-clips",
      [
        { op: "freeze", atMs: 0 },
        { op: "split", atMs: 0 },
        { op: "addTap", atMs: 0, pos: [0.5, 0.5] },
        { op: "addMask", atMs: 0, rect: [0.1, 0.1, 0.2, 0.2] },
        { op: "setMaskRect", maskId: "m1", atMs: 0, rect: [0.1, 0.1, 0.2, 0.2] },
        { op: "addMaskKey", maskId: "m1", atMs: 0 },
        { op: "removeMaskKey", maskId: "m1", atMs: 0 },
        { op: "addClip", source: VIDEO_META },
      ],
      noClips,
    ),
    v(
      "dangling-source",
      [
        { op: "addMask", atMs: 100, rect: [0.1, 0.1, 0.2, 0.2] },
        { op: "trimOut", clipId: "c1", outMs: 5000 },
      ],
      dangling,
    ),
    v("clip-edits", [
      { op: "moveClip", from: 4, to: 0 },
      { op: "moveClip", from: 0.5, to: 1 },
      { op: "moveClip", from: 1, to: 1 },
      { op: "moveClip", from: 0, to: 10 },
      { op: "moveClip", from: 3, to: -2 },
      { op: "setSpeed", clipId: "c1", speed: 0 },
      { op: "setSpeed", clipId: "c1", speed: -1 },
      { op: "setSpeed", clipId: "c9", speed: 2 },
      { op: "setSpeed", clipId: "c2", speed: 2 },
      { op: "setSpeed", clipId: "c4", speed: 2 },
      { op: "setSpeed", clipId: "c1", speed: 1.35 },
      { op: "setSpeed", clipId: "c3", speed: 0.25 },
      { op: "trimIn", clipId: "c2", inMs: 100 },
      { op: "trimIn", clipId: "c9", inMs: 100 },
      { op: "trimIn", clipId: "c1", inMs: 3950 },
      { op: "trimIn", clipId: "c3", inMs: 6500.5 },
      { op: "trimIn", clipId: "c1", inMs: -50 },
      { op: "trimOut", clipId: "c4", outMs: 100 },
      { op: "trimOut", clipId: "c3", outMs: 13000 },
      { op: "trimOut", clipId: "c1", outMs: 50 },
      { op: "trimOut", clipId: "c1", outMs: 2499.5 },
      { op: "setHold", clipId: "c2", holdMs: 0 },
      { op: "setHold", clipId: "c1", holdMs: 2000 },
      { op: "setHold", clipId: "c9", holdMs: 2000 },
      { op: "setHold", clipId: "c2", holdMs: 2500.4 },
      { op: "setHold", clipId: "c4", holdMs: 20 },
      bad({ op: "removeClip", clipId: 3 }),
      { op: "removeClip", clipId: "c9" },
      { op: "removeClip", clipId: "c4" },
      { op: "removeClip", clipId: "c1" },
    ]),
    v("taps", [
      { op: "addTap", atMs: 1000, pos: [1.2, 0] },
      bad({ op: "addTap", atMs: 1000, pos: [0.5] }),
      { op: "addTap", atMs: 4500, pos: [0.5, 0.5] },
      { op: "addTap", atMs: 7000, pos: [0.5, 0.5] },
      { op: "addTap", atMs: 99999, pos: [0.5, 0.5] },
      { op: "addTap", atMs: 5500.25, pos: [0, 1] },
      { op: "addTap", atMs: 0, pos: [0.25, 0.75] },
      { op: "addTapAtSource", sourceId: "s1", sourceMs: 2.5, pos: [0.5, 0.5] },
      { op: "addTapAtSource", sourceId: "s1", sourceMs: -1, pos: [0.5, 0.5] },
      { op: "addTapAtSource", sourceId: "s9", sourceMs: 100, pos: [0.5, 0.5] },
      { op: "addTapAtSource", sourceId: "s2", sourceMs: 0, pos: [0.5, 0.5] },
      { op: "addTapAtSource", sourceId: "s1", sourceMs: 2500, pos: [0.3, 0.3] },
      { op: "moveTap", tapId: "t9", pos: [0.1, 0.1] },
      { op: "moveTap", tapId: "t1", pos: [0.1, -0.1] },
      { op: "moveTap", tapId: "t1", pos: [0.9, 0.05] },
      { op: "retimeTap", tapId: "t9", atMs: 100 },
      { op: "retimeTap", tapId: "t1", atMs: 7000 },
      { op: "retimeTap", tapId: "t1", atMs: 5750.5 },
      { op: "setTapLook" },
      { op: "setTapLook", size: 0 },
      bad({ op: "setTapLook", style: "" }),
      { op: "setTapLook", style: "glow" },
      { op: "setTapLook", color: "red" },
      { op: "setTapLook", size: 1.6 },
      { op: "setTapLook", style: "ring", color: "dark", size: 0.5 },
      { op: "removeTap", tapId: "t9" },
      { op: "removeTap", tapId: "t1" },
    ]),
    v("add-masks", [
      bad({ op: "addMask", atMs: 1000, rect: [0.1, 0.1, 0.2] }),
      { op: "addMask", atMs: 1000, rect: [0.1, 0.1, 0.2, 0.2], style: bad("glass") },
      { op: "addMask", atMs: 1000, rect: [0.1, 0.1, 0.2, 0.2], strength: 1.5 },
      { op: "addMask", atMs: 1000, rect: [0.1, 0.1, 0.2, 0.2], color: "black" },
      { op: "addMask", atMs: 1200.5, rect: [0.1, 0.2, 0.3, 0.1] },
      { op: "addMask", atMs: 7000, rect: [0.9, 0.9, 0.5, 0.005] },
      { op: "addMask", atMs: 5900, rect: [0, 0, 1, 1], style: "pixelate", strength: 0.8 },
      { op: "addMask", atMs: 4500, rect: [0.2, 0.2, 0.2, 0.2], style: "solid", color: "#FF8800" },
      { op: "addMask", atMs: 99999, rect: [0.2, 0.2, 0.2, 0.2], style: "blur" },
    ]),
    v("mask-keys", [
      { op: "addMaskKey", maskId: "m9", atMs: 1500 },
      { op: "addMaskKey", maskId: "m1", atMs: 1004 },
      { op: "addMaskKey", maskId: "m2", atMs: 7000 },
      { op: "addMaskKey", maskId: "m2", atMs: 1500 },
      { op: "addMaskKey", maskId: "m1", atMs: 1500.5 },
      { op: "addMaskKey", maskId: "m1", atMs: 5200 },
      { op: "removeMaskKey", maskId: "m9", atMs: 2000 },
      { op: "removeMaskKey", maskId: "m1", atMs: 1700 },
      { op: "removeMaskKey", maskId: "m2", atMs: 7000 },
      { op: "removeMaskKey", maskId: "m1", atMs: 7000 },
      { op: "removeMaskKey", maskId: "m1", atMs: 2007 },
      { op: "removeMaskKey", maskId: "m1", atMs: 1000 },
      { op: "setMaskRect", maskId: "m9", atMs: 1500, rect: [0.1, 0.1, 0.2, 0.2] },
      { op: "setMaskRect", maskId: "m1", atMs: 7000, rect: [0.1, 0.1, 0.2, 0.2] },
      bad({ op: "setMaskRect", maskId: "m1", atMs: 1500 }),
      { op: "setMaskRect", maskId: "m1", atMs: 1497, rect: [0.5, 0.5, 0.2, 0.2] },
      { op: "setMaskRect", maskId: "m1", atMs: 2500.5, rect: [0.6, 0.6, 0.3, 0.3] },
      { op: "setMaskRect", maskId: "m1", atMs: 5010, rect: [1.2, -0.2, 0.3, 0.3] },
      { op: "setMaskRect", maskId: "m2", atMs: 7000, rect: [0.1, 0.1, 0.1, 0.1] },
      { op: "offsetMask", maskId: "m9", dx: 0.1, dy: 0 },
      bad({ op: "offsetMask", maskId: "m1", dx: 0.1 }),
      { op: "offsetMask", maskId: "m1", dx: 0.75, dy: -0.75 },
      { op: "offsetMask", maskId: "m2", dx: 0.05, dy: 0.125 },
    ]),
    v("mask-look", [
      bad({ op: "retimeMaskEdge", maskId: "m1", edge: "middle", sourceMs: 100 }),
      { op: "retimeMaskEdge", maskId: "m9", edge: "start", sourceMs: 100 },
      { op: "retimeMaskEdge", maskId: "m2", edge: "end", sourceMs: 100 },
      { op: "retimeMaskEdge", maskId: "m1", edge: "start", sourceMs: 2950.5 },
      { op: "retimeMaskEdge", maskId: "m1", edge: "end", sourceMs: 20000 },
      { op: "retimeMaskEdge", maskId: "m1", edge: "start", sourceMs: -300 },
      { op: "setMaskLook", maskId: "m1" },
      { op: "setMaskLook", maskId: "m1", strength: 2 },
      { op: "setMaskLook", maskId: "m1", color: "#12345" },
      { op: "setMaskLook", maskId: "m9", style: "solid" },
      { op: "setMaskLook", maskId: "m1", style: "blur" },
      { op: "setMaskLook", maskId: "m1", strength: 0.25 },
      { op: "setMaskLook", maskId: "m1", style: "blur", strength: 0.25 },
      { op: "setMaskLook", maskId: "m2", color: "#abcdef" },
      { op: "setMaskLook", maskId: "m2", color: null },
      { op: "setMaskLook", maskId: "m1", style: "solid", strength: null, color: "#000000" },
      { op: "removeMask", maskId: "m9" },
      { op: "removeMask", maskId: "m2" },
    ]),
    v("crop", [
      bad({ op: "setClipCrop", clipId: "c1", crop: [0.1, 0.1, 0.5] }),
      { op: "setClipCrop", clipId: "c1", crop: [0.1, 0.1, 0, 0.5] },
      bad({ op: "setClipCrop", clipId: "c1" }),
      { op: "setClipCrop", clipId: "c9", crop: QUAD },
      { op: "setClipCrop", clipId: "c1", crop: null },
      { op: "setClipCrop", clipId: "c1", crop: [0.1, 0.2, 0.5, 0.25] },
      { op: "setClipCrop", clipId: "c1", crop: [0.1, 0.2, 0.5, 0.25] },
      { op: "setClipCrop", clipId: "c2", crop: [0.9, 0.9, 0.5, 0.5] },
      { op: "setClipCrop", clipId: "c4", crop: [0.25, 0, 0.5, 1] },
      { op: "split", atMs: 2000 },
      { op: "freeze", atMs: 1000 },
      { op: "addTap", atMs: 500, pos: [0.05, 0.05] },
      { op: "setClipCrop", clipId: "c1", crop: null },
    ]),
    v(
      "crop-refusals",
      [
        { op: "setClipCrop", clipId: "c1", crop: QUAD },
        { op: "setClipCrop", clipId: "c2", crop: QUAD },
        { op: "setClipCrop", clipId: "c1", crop: null },
      ],
      sizeless,
    ),
    v("mask-fade", [
      { op: "setMaskFade", maskId: "m1" },
      { op: "setMaskFade", maskId: "m1", fadeInMs: -1 },
      bad({ op: "setMaskFade", maskId: "m1", fadeOutMs: "1s" }),
      { op: "setMaskFade", maskId: "m9", fadeInMs: 100 },
      { op: "setMaskFade", maskId: "m2", fadeInMs: 100 },
      { op: "setMaskFade", maskId: "m1", fadeInMs: 1500, fadeOutMs: 600 },
      { op: "setMaskFade", maskId: "m1", fadeInMs: 250.5 },
      { op: "setMaskFade", maskId: "m1", fadeInMs: 251 },
      { op: "setMaskFade", maskId: "m1", fadeOutMs: 400 },
      { op: "retimeMaskEdge", maskId: "m1", edge: "end", sourceMs: 1500 },
      { op: "setMaskFade", maskId: "m1", fadeInMs: null },
      { op: "setMaskFade", maskId: "m1", fadeInMs: 0, fadeOutMs: 0 },
      { op: "setMaskFade", maskId: "m1", fadeOutMs: null },
    ]),
    v("unknown-op", [bad({ op: "explode" }), bad({ op: "split" })]),
  ];
}

// ── Seeded random sequences ───────────────────────────────────────────────────

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 6, 1.35, 0.8, 3];
const TAP_STYLE_IDS = ["target", "glow", "dot", "ring"];
const TAP_COLOR_IDS = ["blue", "light", "dark", "red", "terracotta"];

const round = (v: number, dp: number) => Number(v.toFixed(dp));

/** A random editor doc: one or two videos, sometimes a still; spans, freezes, stills at mixed speeds; taps and masks with a key or two. */
export function randomEditDoc(rand: () => number): EditDoc {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const fps = pick([60, 60, 30, 29.97, 0]);
  const sources: EditSource[] = [
    {
      id: "s1",
      rel: "assets/a.mp4",
      kind: "video",
      width: 1170,
      height: 2532,
      fps: 60,
      durationMs: int(3000, 12000),
    },
  ];
  if (rand() < 0.25) {
    sources.push({
      id: "s2",
      rel: "assets/b.mp4",
      kind: "video",
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: int(2000, 8000),
    });
  }
  if (rand() < 0.35) {
    sources.push({
      id: "s3",
      rel: "assets/c.png",
      kind: "image",
      width: 800,
      height: 600,
      fps: 0,
      durationMs: 0,
    });
  }
  const videos = sources.filter((s) => s.kind === "video");
  const clips: EditClip[] = [];
  for (let n = int(1, 2); clips.length < n; ) {
    const id = math.nextClipId(clips);
    const roll = rand();
    const image = sources.find((s) => s.kind === "image");
    if (roll < 0.15 && image) {
      clips.push({
        id,
        sourceId: image.id,
        inMs: 0,
        outMs: 0,
        speed: 1,
        startMs: 0,
        holdMs: int(5, 30) * 100,
      });
      continue;
    }
    const s = pick(videos);
    if (roll < 0.3) {
      const at = int(0, s.durationMs);
      clips.push({
        id,
        sourceId: s.id,
        inMs: at,
        outMs: at,
        speed: 1,
        startMs: 0,
        holdMs: int(3, 25) * 100,
      });
      continue;
    }
    const inMs = int(0, s.durationMs - 300);
    const outMs = Math.min(s.durationMs, inMs + int(300, 5000));
    clips.push({ id, sourceId: s.id, inMs, outMs, speed: pick(SPEEDS), startMs: 0 });
  }
  const taps: EditTap[] = [];
  for (let n = int(0, 1); taps.length < n; ) {
    const s = pick(videos);
    taps.push({
      id: math.nextTapId(taps),
      sourceId: s.id,
      sourceMs: int(0, s.durationMs),
      pos: [round(rand(), 2), round(rand(), 2)],
    });
  }
  const docMasks: EditMask[] = [];
  for (let n = int(0, 1); docMasks.length < n; ) {
    const s = pick(sources);
    const startMs = s.kind === "image" ? 0 : int(0, Math.max(0, s.durationMs - 500));
    const endMs = s.kind === "image" ? 0 : Math.min(s.durationMs, startMs + int(100, 4000));
    const keyTimes =
      s.kind === "image" ? [0] : [...new Set([startMs, int(startMs, endMs)])].sort((a, b) => a - b);
    const mask: EditMask = {
      id: masks.nextMaskId(docMasks),
      sourceId: s.id,
      style: pick(MASK_STYLES),
      startMs,
      endMs,
      keys: keyTimes.map((sourceMs) => ({
        sourceMs,
        rect: masks.clampRect([
          round(rand(), 2),
          round(rand(), 2),
          round(rand() * 0.5, 2),
          round(rand() * 0.5, 2),
        ]),
      })),
    };
    if (rand() < 0.3) mask.strength = round(rand(), 2);
    if (mask.style === "solid" && rand() < 0.3) mask.color = "#ff0000";
    const span = endMs - startMs;
    docMasks.push(
      s.kind === "video" && rand() < 0.35
        ? masks.withMaskFades(mask, int(0, span / 2), int(0, span / 2))
        : mask,
    );
  }
  for (const [i, c] of clips.entries()) {
    const s = sources.find((x) => x.id === c.sourceId);
    if (!s || rand() >= 0.2) continue;
    const crop = math.snapCropRect(
      [
        round(rand() * 0.5, 2),
        round(rand() * 0.5, 2),
        round(0.2 + rand() * 0.6, 2),
        round(0.2 + rand() * 0.6, 2),
      ],
      s,
    );
    clips[i] = { ...c, crop };
  }
  const doc: EditDoc = {
    version: clips.some((c) => c.crop) ? 3 : docMasks.length > 0 ? 2 : 1,
    name: "rand",
    sources,
    settings: { width: 1080, height: 1920, fps },
    clips: math.relayout(clips),
  };
  if (taps.length > 0) doc.taps = taps;
  if (docMasks.length > 0) doc.masks = docMasks;
  return doc;
}

/** A random op against `doc`, biased to real ids and on-timeline times with a share of misses, holds, edges and bad arguments. */
export function randomEditOp(rand: () => number, doc: EditDoc): EditOp {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const total = math.timelineDurationMs(doc.clips);
  const fps = doc.settings.fps > 0 ? doc.settings.fps : 60;
  const atMs = () => {
    const roll = rand();
    if (roll < 0.08) return total;
    if (roll < 0.12) return round(total + 40, 1);
    if (roll < 0.15) return -5;
    if (roll < 0.3) return round(Math.round((rand() * total * fps) / 1000) * (1000 / fps), 3);
    return round(rand() * total, 1);
  };
  const clipId = () => (rand() < 0.08 || doc.clips.length === 0 ? "c99" : pick(doc.clips).id);
  const tapId = () => (rand() < 0.1 || !doc.taps?.length ? "t99" : pick(doc.taps).id);
  const maskId = () => (rand() < 0.1 || !doc.masks?.length ? "m99" : pick(doc.masks).id);
  const pos = (): [number, number] => [round(rand(), 2), round(rand(), 2)];
  const rect = (): [number, number, number, number] => [
    round(rand(), 2),
    round(rand(), 2),
    round(rand() * 0.6, 2),
    round(rand() * 0.6, 2),
  ];
  const source = () => {
    const roll = rand();
    if (roll < 0.75 && doc.sources.length > 0) {
      const s = pick(doc.sources);
      return {
        rel: s.rel,
        kind: s.kind ?? "video",
        width: s.width,
        height: s.height,
        fps: s.fps,
        durationMs: s.durationMs,
      };
    }
    return roll < 0.85 ? newVideo : newImage;
  };
  const picked = pick([
    "addClip",
    "insertClip",
    "split",
    "split",
    "freeze",
    "freeze",
    "removeClip",
    "moveClip",
    "setSpeed",
    "setSpeed",
    "trimIn",
    "trimOut",
    "setHold",
    "setClipCrop",
    "addTap",
    "addTap",
    "addTapAtSource",
    "moveTap",
    "retimeTap",
    "removeTap",
    "setTapLook",
    "addMask",
    "setMaskRect",
    "setMaskRect",
    "offsetMask",
    "addMaskKey",
    "removeMaskKey",
    "retimeMaskEdge",
    "setMaskLook",
    "setMaskFade",
    "removeMask",
  ] as const);
  // Edits of taps or masks a doc doesn't have mostly add one instead, so sequences reach the interesting paths.
  const targetsMask = [
    "setMaskRect",
    "offsetMask",
    "addMaskKey",
    "removeMaskKey",
    "retimeMaskEdge",
    "setMaskLook",
    "setMaskFade",
    "removeMask",
  ].includes(picked);
  const targetsTap = ["moveTap", "retimeTap", "removeTap"].includes(picked);
  const kind =
    targetsMask && !doc.masks?.length && rand() < 0.5
      ? "addMask"
      : targetsTap && !doc.taps?.length && rand() < 0.8
        ? "addTap"
        : picked;
  switch (kind) {
    case "addClip":
      return rand() < 0.5
        ? { op: kind, source: source() }
        : { op: kind, source: source(), index: Math.floor(rand() * (doc.clips.length + 2)) - 1 };
    case "insertClip":
      return { op: kind, source: source(), atMs: atMs() };
    case "split":
      return { op: kind, atMs: atMs() };
    case "freeze":
      return rand() < 0.7
        ? { op: kind, atMs: atMs() }
        : { op: kind, atMs: atMs(), holdMs: pick([50, 1500, 2345.6]) };
    case "removeClip":
      return { op: kind, clipId: clipId() };
    case "moveClip":
      return {
        op: kind,
        from: Math.floor(rand() * (doc.clips.length + 1)),
        to: Math.floor(rand() * (doc.clips.length + 2)) - 1,
      };
    case "setSpeed":
      return { op: kind, clipId: clipId(), speed: rand() < 0.05 ? 0 : pick(SPEEDS) };
    case "trimIn":
      return { op: kind, clipId: clipId(), inMs: round(rand() * 12000, 1) };
    case "trimOut":
      return { op: kind, clipId: clipId(), outMs: round(rand() * 13000, 1) };
    case "setHold":
      return { op: kind, clipId: clipId(), holdMs: pick([50, 400, 2000, 3333.3]) };
    case "setClipCrop": {
      if (rand() < 0.25) return { op: kind, clipId: clipId(), crop: null };
      const edge = () => (rand() < 0.05 ? 0 : round(0.05 + rand() * 0.6, 2));
      return {
        op: kind,
        clipId: clipId(),
        crop: [round(rand() * 0.6, 2), round(rand() * 0.6, 2), edge(), edge()],
      };
    }
    case "addTap":
      return { op: kind, atMs: atMs(), pos: pos() };
    case "addTapAtSource":
      return {
        op: kind,
        sourceId: pick([...doc.sources.map((s) => s.id), "s9"]),
        sourceMs: Math.floor(rand() * 9000),
        pos: pos(),
      };
    case "moveTap":
      return { op: kind, tapId: tapId(), pos: pos() };
    case "retimeTap":
      return { op: kind, tapId: tapId(), atMs: atMs() };
    case "removeTap":
      return { op: kind, tapId: tapId() };
    case "setTapLook": {
      const roll = rand();
      if (roll < 0.33) return { op: kind, style: pick(TAP_STYLE_IDS) };
      if (roll < 0.66) return { op: kind, color: pick(TAP_COLOR_IDS) };
      return { op: kind, size: pick([0.5, 1.25, 2.75]) };
    }
    case "addMask": {
      const roll = rand();
      if (roll < 0.6) return { op: kind, atMs: atMs(), rect: rect() };
      return {
        op: kind,
        atMs: atMs(),
        rect: rect(),
        style: pick(MASK_STYLES),
        strength: round(rand(), 2),
      };
    }
    case "setMaskRect":
      return { op: kind, maskId: maskId(), atMs: atMs(), rect: rect() };
    case "offsetMask":
      return { op: kind, maskId: maskId(), dx: round(rand() - 0.5, 2), dy: round(rand() - 0.5, 2) };
    case "addMaskKey":
    case "removeMaskKey":
      return { op: kind, maskId: maskId(), atMs: atMs() };
    case "retimeMaskEdge":
      return {
        op: kind,
        maskId: maskId(),
        edge: rand() < 0.5 ? "start" : "end",
        sourceMs: round(rand() * 13000, 1),
      };
    case "setMaskLook": {
      const roll = rand();
      if (roll < 0.4) return { op: kind, maskId: maskId(), style: pick(MASK_STYLES) };
      if (roll < 0.7)
        return { op: kind, maskId: maskId(), strength: rand() < 0.2 ? null : round(rand(), 2) };
      return { op: kind, maskId: maskId(), color: rand() < 0.3 ? null : "#00ff00" };
    }
    case "setMaskFade": {
      const ms = () => pick([0, 100, 250, 600, 1500, null]);
      const roll = rand();
      if (roll < 0.4) return { op: kind, maskId: maskId(), fadeInMs: ms() };
      if (roll < 0.8) return { op: kind, maskId: maskId(), fadeOutMs: ms() };
      return { op: kind, maskId: maskId(), fadeInMs: ms(), fadeOutMs: ms() };
    }
    case "removeMask":
      return { op: kind, maskId: maskId() };
  }
}

function randomVectors(): OpVector[] {
  const out: OpVector[] = [];
  for (let i = 0; i < RANDOM_SEQUENCES; i++) {
    const rand = mulberry32(0x6b6f6f6b + i);
    const doc = randomEditDoc(rand);
    let current = doc;
    const ops: EditOp[] = [];
    for (let n = 0; n < 4; n++) {
      const op = randomEditOp(rand, current);
      ops.push(op);
      const result = applyEditOp(current, op);
      if (result.ok) current = result.doc;
    }
    out.push(runSteps(`random/${i}`, doc, ops));
  }
  return out;
}

export function buildEditVectors(): EditVectors {
  return {
    version: EDIT_VECTORS_VERSION,
    constants: constants(),
    fns: fnCases(),
    ops: [...handVectors(), ...randomVectors()],
  };
}

/** One vector per line, so a diff names the case that moved. */
export function serialiseEditVectors(v: EditVectors): string {
  const lines = (list: unknown[]) => list.map((item) => JSON.stringify(item)).join(",\n");
  return `{"version":${v.version},"constants":${JSON.stringify(v.constants)},\n"fns":[\n${lines(v.fns)}\n],\n"ops":[\n${lines(v.ops)}\n]}\n`;
}
