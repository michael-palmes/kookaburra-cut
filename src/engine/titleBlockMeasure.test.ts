import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import type { SceneDoc } from "./sceneDocSchema";
import {
  growthFromHeights,
  NO_TITLE_CASCADE,
  solveTitleCascade,
  type TitleTextInput,
} from "./titleBlockMeasure";

/** Cold-cache tests: real troika measurement only runs in the app, where the export preamble settles it before frame 0. */

const theme = {
  colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
  typography: {
    headline: { family: "Inter", weight: 600 },
    body: { family: "Inter", weight: 400 },
  },
} as unknown as Theme;

const docWith = (parts: Partial<SceneDoc>): SceneDoc => ({ version: 1, ...parts }) as SceneDoc;

const titleInput = (over: Partial<TitleTextInput> = {}): TitleTextInput => ({
  text: "Ship it",
  face: "headline",
  fontSize: 0.56,
  textAlign: "center",
  textKey: "title",
  ...over,
});

describe("growthFromHeights", () => {
  it("is exactly zero for one line, whatever the heights", () => {
    expect(Object.is(growthFromHeights(0.63, 0.63), 0)).toBe(true);
    expect(Object.is(growthFromHeights(0.8, 0.63), 0)).toBe(true);
    expect(Object.is(growthFromHeights(0, 0.63), 0)).toBe(true);
  });

  it("is the height beyond one line once the block wraps", () => {
    expect(growthFromHeights(1.26, 0.63)).toBeCloseTo(0.63, 12);
    expect(growthFromHeights(1.89, 0.63)).toBeCloseTo(1.26, 12);
  });

  it("returns zero without a usable single-line probe", () => {
    expect(growthFromHeights(1.26, 0)).toBe(0);
    expect(growthFromHeights(1.26, Number.NaN)).toBe(0);
  });
});

describe("solveTitleCascade", () => {
  it("has no growth and requests both the block and its single-line probe on a cold cache", () => {
    const cascade = solveTitleCascade(titleInput({ maxWidth: 6 }), null, theme, undefined);
    expect(cascade.titleGrowth).toBe(0);
    expect(cascade.subtitleGrowth).toBe(0);
    expect(cascade.pending).toHaveLength(2);
    expect(cascade.pending[0].maxWidth).toBe(6);
    expect(cascade.pending[1].maxWidth).toBe(Number.POSITIVE_INFINITY);
  });

  it("folds hard breaks to spaces in the probe so it stays one line", () => {
    const cascade = solveTitleCascade(
      titleInput({ text: "Ship\nit", maxWidth: 6 }),
      null,
      theme,
      undefined,
    );
    expect(cascade.pending[0].text).toBe("Ship\nit");
    expect(cascade.pending[1].text).toBe("Ship it");
  });

  it("returns the shared no-growth solution when there is nothing to measure", () => {
    expect(solveTitleCascade(null, null, theme, undefined)).toBe(NO_TITLE_CASCADE);
    expect(solveTitleCascade(titleInput({ text: "   " }), null, theme, undefined)).toBe(
      NO_TITLE_CASCADE,
    );
  });

  it("mirrors the sidecar Size and LineHeight overrides, like the renderer", () => {
    const doc = docWith({ textStyle: { titleSize: 0.5, titleLineHeight: 1.4 } });
    const { pending } = solveTitleCascade(titleInput(), null, theme, doc);
    expect(pending[0].fontSize).toBeCloseTo(0.28, 12);
    expect(pending[0].lineHeight).toBe(1.4);
  });

  it("ignores sidecar overrides for a headline that registers no text key", () => {
    const doc = docWith({ textStyle: { titleSize: 0.5 } });
    const { pending } = solveTitleCascade(titleInput({ textKey: undefined }), null, theme, doc);
    expect(pending[0].fontSize).toBeCloseTo(0.56, 12);
    expect(pending[0].lineHeight).toBeUndefined();
  });

  it("measures the subtitle in the body face alongside the title", () => {
    const cascade = solveTitleCascade(
      titleInput({ maxWidth: 6 }),
      { text: "and again", face: "body", fontSize: 0.23, textAlign: "center", textKey: "subtitle" },
      theme,
      undefined,
    );
    expect(cascade.pending).toHaveLength(4);
    expect(new Set(cascade.pending.map((s) => s.text))).toEqual(new Set(["Ship it", "and again"]));
  });
});
