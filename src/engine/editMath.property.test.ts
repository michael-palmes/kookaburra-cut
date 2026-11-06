import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EditClip } from "./edit";
import {
  clipIndexAt,
  clipTimelineMs,
  edgeTargetsMs,
  MIN_CLIP_SOURCE_MS,
  MIN_HOLD_MS,
  moveClip,
  outputToSource,
  relayout,
  splitAt,
  timelineDurationMs,
  timelineToSource,
  trimClipIn,
  trimClipOut,
} from "./editMath";

const SOURCE_MS = 60_000;

/** A video clip with a span at or over the floor, inside a 60 s source. */
const videoClip = fc
  .record({
    inMs: fc.integer({ min: 0, max: SOURCE_MS - MIN_CLIP_SOURCE_MS }),
    span: fc.integer({ min: MIN_CLIP_SOURCE_MS, max: SOURCE_MS }),
    speed: fc.double({ min: 0.25, max: 4, noNaN: true }),
  })
  .map(({ inMs, span, speed }) => ({ inMs, outMs: Math.min(SOURCE_MS, inMs + span), speed }));

/** A freeze: one source frame held for at least the floor. */
const freezeClip = fc
  .record({
    at: fc.integer({ min: 0, max: SOURCE_MS }),
    holdMs: fc.integer({ min: MIN_HOLD_MS, max: 10_000 }),
  })
  .map(({ at, holdMs }) => ({ inMs: at, outMs: at, speed: 1, holdMs }));

/** A laid-out timeline of one to eight clips with unique ids. */
const timeline: fc.Arbitrary<EditClip[]> = fc
  .array(fc.oneof({ weight: 3, arbitrary: videoClip }, { weight: 1, arbitrary: freezeClip }), {
    minLength: 1,
    maxLength: 8,
  })
  .map((clips) =>
    relayout(clips.map((clip, i) => ({ ...clip, id: `c${i + 1}`, sourceId: "s1", startMs: 0 }))),
  );

/** A timeline and one of its clip indices. */
const timelineAndIndex = timeline.chain((clips) =>
  fc.record({ clips: fc.constant(clips), index: fc.nat({ max: clips.length - 1 }) }),
);

/** A timeline and a moment inside one of its clips, from the exact start the layout accumulates. */
const timelineAndMoment = timelineAndIndex.chain(({ clips, index }) =>
  fc.double({ min: 0, max: 0.999, noNaN: true }).map((fraction) => {
    let start = 0;
    for (let i = 0; i < index; i++) start += clipTimelineMs(clips[i]);
    return { clips, index, tMs: start + fraction * clipTimelineMs(clips[index]) };
  }),
);

const withoutStart = ({ startMs: _, ...clip }: EditClip) => clip;

describe("relayout", () => {
  it("lays clips end to end from 0 and changes nothing but startMs", () => {
    fc.assert(
      fc.property(timeline, (clips) => {
        const laid = relayout(clips);
        let t = 0;
        for (const [i, clip] of laid.entries()) {
          expect(clip.startMs).toBe(Math.round(t));
          expect(withoutStart(clip)).toEqual(withoutStart(clips[i]));
          t += clipTimelineMs(clip);
        }
        expect(timelineDurationMs(laid)).toBe(t);
        expect(edgeTargetsMs(laid).at(-1)).toBe(t);
      }),
    );
  });

  it("finds every clip under a moment inside it", () => {
    fc.assert(
      fc.property(timelineAndMoment, ({ clips, index, tMs }) => {
        expect(clipIndexAt(clips, tMs)).toBe(index);
      }),
    );
  });
});

describe("splitAt", () => {
  it("cuts a clip into halves that keep its source span and clear the floor, or refuses", () => {
    fc.assert(
      fc.property(timelineAndMoment, ({ clips, index, tMs }) => {
        const clip = clips[index];
        const split = splitAt(clips, tMs, "cut");
        if (split === null) {
          if (clip.holdMs !== undefined) return;
          const offset = (tMs - clip.startMs) * clip.speed;
          const span = clip.outMs - clip.inMs;
          expect(
            offset < MIN_CLIP_SOURCE_MS + 0.5 || span - offset < MIN_CLIP_SOURCE_MS + 0.5,
          ).toBe(true);
          return;
        }
        expect(clip.holdMs).toBeUndefined();
        expect(split).toHaveLength(clips.length + 1);
        const [left, right] = [split[index], split[index + 1]];
        expect(left.inMs).toBe(clip.inMs);
        expect(right.outMs).toBe(clip.outMs);
        expect(left.outMs).toBe(right.inMs);
        expect(right.id).toBe("cut");
        expect(left.outMs - left.inMs).toBeGreaterThanOrEqual(MIN_CLIP_SOURCE_MS);
        expect(right.outMs - right.inMs).toBeGreaterThanOrEqual(MIN_CLIP_SOURCE_MS);
        expect(left.outMs).toBe(outputToSource(clips, tMs)?.sourceMs);
        expect(timelineDurationMs(split)).toBeCloseTo(timelineDurationMs(clips), 6);
        const others = (list: EditClip[], skip: number[]) =>
          list.filter((_, i) => !skip.includes(i)).map(withoutStart);
        expect(others(split, [index, index + 1])).toEqual(others(clips, [index]));
      }),
    );
  });
});

describe("moveClip", () => {
  it("is undone by the reverse move", () => {
    fc.assert(
      fc.property(
        timelineAndIndex.chain(({ clips, index }) =>
          fc.record({
            clips: fc.constant(clips),
            from: fc.constant(index),
            to: fc.nat({ max: clips.length - 1 }),
          }),
        ),
        ({ clips, from, to }) => {
          const moved = moveClip(clips, from, to);
          expect(moved).toHaveLength(clips.length);
          expect(moved[to].id).toBe(clips[from].id);
          expect(moveClip(moved, to, from)).toEqual(clips);
        },
      ),
    );
  });
});

describe("trims", () => {
  // -0 rounds to -0, which the clamp turns into +0.
  const request = fc
    .double({ min: -1e6, max: 1e6, noNaN: true })
    .map((ms) => (Object.is(ms, -0) ? 0 : ms));

  it("trimClipIn keeps the in-point inside [0, outMs - floor] and lands exact requests", () => {
    fc.assert(
      fc.property(timelineAndIndex, request, ({ clips, index }, inMs) => {
        const clip = clips[index];
        const trimmed = trimClipIn(clips, clip.id, inMs)[index];
        if (clip.holdMs !== undefined) {
          expect(trimmed).toEqual(clip);
          return;
        }
        expect(Number.isInteger(trimmed.inMs)).toBe(true);
        expect(trimmed.inMs).toBeGreaterThanOrEqual(0);
        expect(trimmed.inMs).toBeLessThanOrEqual(clip.outMs - MIN_CLIP_SOURCE_MS);
        expect(trimmed.outMs).toBe(clip.outMs);
        if (inMs >= 0 && inMs <= clip.outMs - MIN_CLIP_SOURCE_MS) {
          expect(trimmed.inMs).toBe(Math.round(inMs));
        }
      }),
    );
  });

  it("trimClipOut keeps the out-point inside [inMs + floor, source end] and lands exact requests", () => {
    fc.assert(
      fc.property(timelineAndIndex, request, ({ clips, index }, outMs) => {
        const clip = clips[index];
        const trimmed = trimClipOut(clips, clip.id, outMs, SOURCE_MS)[index];
        if (clip.holdMs !== undefined) {
          expect(trimmed).toEqual(clip);
          return;
        }
        expect(Number.isInteger(trimmed.outMs)).toBe(true);
        expect(trimmed.outMs).toBeGreaterThanOrEqual(clip.inMs + MIN_CLIP_SOURCE_MS);
        expect(trimmed.outMs).toBeLessThanOrEqual(SOURCE_MS);
        expect(trimmed.inMs).toBe(clip.inMs);
        if (outMs >= clip.inMs + MIN_CLIP_SOURCE_MS && outMs <= SOURCE_MS) {
          expect(trimmed.outMs).toBe(Math.round(outMs));
        }
      }),
    );
  });
});

describe("outputToSource", () => {
  it("agrees with timelineToSource inside a clip and stays within its span", () => {
    fc.assert(
      fc.property(timelineAndMoment, ({ clips, index, tMs }) => {
        const clip = clips[index];
        const hit = outputToSource(clips, tMs);
        if (clip.holdMs !== undefined) {
          expect(hit).toBeNull();
          return;
        }
        expect(hit).toEqual({
          sourceId: clip.sourceId,
          sourceMs: Math.round(timelineToSource(clip, tMs)),
        });
        const sourceMs = hit?.sourceMs ?? Number.NaN;
        expect(sourceMs).toBeGreaterThanOrEqual(clip.inMs);
        expect(sourceMs).toBeLessThanOrEqual(clip.outMs);
      }),
    );
  });

  it("is null off the timeline", () => {
    fc.assert(
      fc.property(timeline, fc.double({ min: 0, max: 1e6, noNaN: true }), (clips, past) => {
        expect(outputToSource(clips, timelineDurationMs(clips) + past)).toBeNull();
        expect(outputToSource(clips, -1 - past)).toBeNull();
      }),
    );
  });
});
