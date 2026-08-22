import { describe, expect, it } from "vitest";
import type { CompareTrackDoc } from "../../engine/compareEditStore";
import { COMPARE_PRESETS } from "../../engine/comparePresets";
import { DEFAULT_EASE } from "../../engine/ease";
import { MIN_KEY_GAP_MS } from "../../engine/keyedTrack";
import { compareSampleAt, compareSpecOf } from "../../engine/sceneCompare";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  buildCompareAnimationTrack,
  type CompareAnimationFields,
  readCompareAnimationFields,
} from "./compareAnimationModel";

const DURATION = 3000;

const preset = (id: string): CompareTrackDoc => {
  const entry = COMPARE_PRESETS.find((p) => p.id === id);
  if (!entry) throw new Error(`no preset ${id}`);
  return entry.build(DURATION);
};

const specFor = (track: CompareTrackDoc, angleDeg?: number) =>
  compareSpecOf({
    version: 1,
    compare: { mask: { type: "linear", angleDeg }, track },
  } as SceneDoc);

describe("compare animation fields (read)", () => {
  it("seeds from the static divider with no keys", () => {
    const read = readCompareAnimationFields(undefined, { value: 0.8 }, DURATION);
    expect(read.shape).toBe("empty");
    expect(read.keyCount).toBe(0);
    expect(read.fields).toEqual({
      fromValue: 0.8,
      toValue: 0,
      startMs: 0,
      durationMs: 2550,
      ease: DEFAULT_EASE,
    });
  });

  it("falls back to a half split when the block carries no static value", () => {
    const read = readCompareAnimationFields({ keys: [], segments: [] }, {}, DURATION);
    expect(read.fields.fromValue).toBe(0.5);
    expect(read.shape).toBe("empty");
  });

  it("reads the reveal preset as the simple two-key shape", () => {
    const read = readCompareAnimationFields(preset("reveal"), { value: 0.5 }, DURATION);
    expect(read.shape).toBe("simple");
    expect(read.keyCount).toBe(2);
    expect(read.fields).toEqual({
      fromValue: 1,
      toValue: 0,
      startMs: 0,
      durationMs: 2550,
      ease: "inOutCubic",
    });
  });

  it("reads the single-key hold preset, seeding the length it has no second key for", () => {
    const read = readCompareAnimationFields(preset("hold"), { value: 0.2 }, DURATION);
    expect(read.shape).toBe("simple");
    expect(read.keyCount).toBe(1);
    expect(read.fields.fromValue).toBe(0.5);
    expect(read.fields.toValue).toBe(0.5);
    expect(read.fields.startMs).toBe(0);
    expect(read.fields.durationMs).toBe(2550);
  });

  it("reports rich tracks with their key count and the derived first/last values", () => {
    const peek = readCompareAnimationFields(preset("peek"), { value: 0.5 }, DURATION);
    expect(peek.shape).toBe("rich");
    expect(peek.keyCount).toBe(4);
    expect(peek.fields.fromValue).toBe(1);
    expect(peek.fields.toValue).toBe(0);
    expect(peek.fields.startMs).toBe(0);
    expect(peek.fields.durationMs).toBe(2550);
    expect(peek.fields.ease).toBe("outCubic");
    const sweep = readCompareAnimationFields(preset("sweep-settle"), { value: 0.5 }, DURATION);
    expect(sweep.shape).toBe("rich");
    expect(sweep.keyCount).toBe(3);
    expect(sweep.fields.toValue).toBe(0.5);
  });

  it("reads first and last by time, whatever order the doc lists keys in", () => {
    const read = readCompareAnimationFields(
      {
        keys: [
          { id: "b", tMs: 900, pose: { value: 0.25 } },
          { id: "a", tMs: 200, pose: { value: 1 } },
        ],
        segments: [{ from: "a", to: "b", ease: "outQuad" }],
      },
      { value: 0.5 },
      DURATION,
    );
    expect(read.fields).toEqual({
      fromValue: 1,
      toValue: 0.25,
      startMs: 200,
      durationMs: 700,
      ease: "outQuad",
    });
  });

  it("degrades an unknown ease to the default rather than showing it", () => {
    const read = readCompareAnimationFields(
      {
        keys: [
          { id: "k1", tMs: 0, pose: { value: 1 } },
          { id: "k2", tMs: 500, pose: { value: 0 } },
        ],
        segments: [{ from: "k1", to: "k2", ease: "wobble" }],
      },
      {},
      DURATION,
    );
    expect(read.fields.ease).toBe(DEFAULT_EASE);
  });

  it("reads keyed angles, and reports none when the keys carry none", () => {
    const plain = readCompareAnimationFields(preset("reveal"), {}, DURATION);
    expect(plain.fields.angleFromDeg).toBeUndefined();
    expect(plain.fields.angleToDeg).toBeUndefined();
    const keyed = readCompareAnimationFields(
      {
        keys: [
          { id: "k1", tMs: 0, pose: { value: 1, angleDeg: 90 } },
          { id: "k2", tMs: 800, pose: { value: 0, angleDeg: 135 } },
        ],
        segments: [{ from: "k1", to: "k2", ease: "inOutCubic" }],
      },
      { angleDeg: 90 },
      DURATION,
    );
    expect(keyed.fields.angleFromDeg).toBe(90);
    expect(keyed.fields.angleToDeg).toBe(135);
  });
});

describe("compare animation fields (build)", () => {
  const base: CompareAnimationFields = {
    fromValue: 1,
    toValue: 0,
    startMs: 0,
    durationMs: 2550,
    ease: "inOutCubic",
  };

  it("rebuilds the reveal preset exactly from its own fields", () => {
    const track = preset("reveal");
    const read = readCompareAnimationFields(track, {}, DURATION);
    expect(buildCompareAnimationTrack(read.fields, DURATION)).toEqual(track);
  });

  it("round-trips every field back through a read", () => {
    const fields: CompareAnimationFields = {
      fromValue: 0.25,
      toValue: 0.9,
      startMs: 400,
      durationMs: 1200,
      ease: "outBack",
      angleFromDeg: 90,
      angleToDeg: 20,
    };
    const track = buildCompareAnimationTrack(fields, DURATION);
    const read = readCompareAnimationFields(track, {}, DURATION);
    expect(read.shape).toBe("simple");
    expect(read.fields).toEqual(fields);
  });

  it("writes two keys and one segment, whatever it was handed", () => {
    const track = buildCompareAnimationTrack(base, DURATION);
    expect(track.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(track.segments).toEqual([{ from: "k1", to: "k2", ease: "inOutCubic" }]);
  });

  it("rounds times to whole ms and clamps values into 0..1", () => {
    const track = buildCompareAnimationTrack(
      { ...base, fromValue: 1.6, toValue: -0.4, startMs: 120.6, durationMs: 300.4 },
      DURATION,
    );
    expect(track.keys[0]).toEqual({ id: "k1", tMs: 121, pose: { value: 1 } });
    expect(track.keys[1]).toEqual({ id: "k2", tMs: 421, pose: { value: 0 } });
  });

  it("clamps the window to the scene and never writes a sub-frame span", () => {
    const overrun = buildCompareAnimationTrack({ ...base, startMs: 1000, durationMs: 5000 }, 3000);
    expect(overrun.keys[1].tMs).toBe(3000);
    const lateStart = buildCompareAnimationTrack({ ...base, startMs: 2995 }, 3000);
    expect(lateStart.keys[0].tMs).toBe(3000 - MIN_KEY_GAP_MS);
    expect(lateStart.keys[1].tMs).toBe(3000);
    const tiny = buildCompareAnimationTrack({ ...base, startMs: 0, durationMs: 1 }, 3000);
    expect(tiny.keys[1].tMs).toBe(MIN_KEY_GAP_MS);
  });

  it("falls back to the default ease for a name the engine does not know", () => {
    const track = buildCompareAnimationTrack({ ...base, ease: "wobble" }, DURATION);
    expect(track.segments[0].ease).toBe(DEFAULT_EASE);
  });

  it("writes pose.angleDeg only on the keys whose angle field is set", () => {
    const none = buildCompareAnimationTrack(base, DURATION);
    expect(none.keys[0].pose).toEqual({ value: 1 });
    expect(none.keys[1].pose).toEqual({ value: 0 });
    const one = buildCompareAnimationTrack({ ...base, angleFromDeg: 60 }, DURATION);
    expect(one.keys[0].pose).toEqual({ value: 1, angleDeg: 60 });
    expect(one.keys[1].pose).toEqual({ value: 0 });
    const both = buildCompareAnimationTrack(
      { ...base, angleFromDeg: 60, angleToDeg: 120 },
      DURATION,
    );
    expect(both.keys[1].pose).toEqual({ value: 0, angleDeg: 120 });
  });

  it("samples the divider at exactly the fields it was built from", () => {
    const track = buildCompareAnimationTrack(
      { ...base, fromValue: 0.9, toValue: 0.1, startMs: 500, durationMs: 1000, angleFromDeg: 90 },
      DURATION,
    );
    const spec = specFor(track, 45);
    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(compareSampleAt(spec, 500).value).toBeCloseTo(0.9, 10);
    expect(compareSampleAt(spec, 1500).value).toBeCloseTo(0.1, 10);
    // k2 carries no angle, so the static one holds from it on.
    expect(compareSampleAt(spec, 500).angleDeg).toBe(90);
    expect(compareSampleAt(spec, 1500).angleDeg).toBe(45);
  });

  it("leaves an angle-free track sampling on the static mask angle", () => {
    const spec = specFor(buildCompareAnimationTrack(base, DURATION), 30);
    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(compareSampleAt(spec, 0).angleDeg).toBe(30);
    expect(compareSampleAt(spec, DURATION).angleDeg).toBe(30);
  });
});
