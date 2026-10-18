import { describe, expect, it } from "vitest";
import { collectParseWarnings } from "./parseWarnings";
import { buildSceneTimeline, type TransitionSpec } from "./sceneTimeline";
import {
  preloadTransitionMasks,
  resolveSlotTransitionMasks,
  transitionMaskForFrame,
  transitionMaskRefs,
} from "./transitionMask";

const timeline = (spec: TransitionSpec) =>
  buildSceneTimeline([
    { id: "a", durationMs: 2000, transition: spec },
    { id: "b", durationMs: 2000 },
  ]);

const mask = { type: "luma", durationMs: 600, shape: "image", src: "assets/star.png" } as const;

describe("resolveSlotTransitionMasks", () => {
  it("attaches the resolved URL to the incoming slot", () => {
    const { result, warnings } = collectParseWarnings(() =>
      resolveSlotTransitionMasks(timeline(mask), (src) => `/p/${src}`),
    );
    expect(warnings).toEqual([]);
    expect(result[0].transitionMask).toBeUndefined();
    expect(result[1].transitionMask).toEqual({ src: "assets/star.png", url: "/p/assets/star.png" });
    expect(transitionMaskRefs(result)).toEqual([
      { src: "assets/star.png", url: "/p/assets/star.png" },
    ]);
  });

  it("warns and leaves the URL null when the file is missing", () => {
    const { result, warnings } = collectParseWarnings(() =>
      resolveSlotTransitionMasks(timeline(mask), () => {
        throw new Error("gone");
      }),
    );
    expect(result[1].transitionMask).toEqual({ src: "assets/star.png", url: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/assets\/star\.png" not found \(gone\)/);
  });

  it("warns about a bad src or a non-luma type and attaches nothing", () => {
    for (const spec of [
      { ...mask, src: "star.png" },
      { ...mask, type: "zoom" as const },
    ]) {
      const { result, warnings } = collectParseWarnings(() =>
        resolveSlotTransitionMasks(timeline(spec), (src) => src),
      );
      expect(result[1].transitionMask).toBeUndefined();
      expect(transitionMaskRefs(result)).toEqual([]);
      expect(warnings).toHaveLength(1);
    }
  });

  it("leaves every other transition untouched", () => {
    const slots = timeline({ type: "luma", durationMs: 600, shape: "iris" });
    expect(resolveSlotTransitionMasks(slots, () => "x")).toEqual(slots);
  });
});

describe("preloadTransitionMasks", () => {
  it("is a no-op without image masks", async () => {
    await expect(
      preloadTransitionMasks(timeline({ type: "crossfade", durationMs: 600 })),
    ).resolves.toBeUndefined();
  });

  it("rejects an unresolved mask before any frame renders", async () => {
    await expect(preloadTransitionMasks(timeline(mask))).rejects.toThrow(
      /image mask "assets\/star\.png" not found/,
    );
  });
});

describe("transitionMaskForFrame", () => {
  it("returns null for an unresolved mask outside an export", () => {
    expect(
      transitionMaskForFrame({
        progress: 0.5,
        mask: { src: "assets/star.png", url: null },
      } as never),
    ).toBeNull();
  });
});
