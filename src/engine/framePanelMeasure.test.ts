import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { computeFormat, FORMATS } from "./format";
import { solvePanelLayout, splitBullets } from "./framePanelMeasure";
import type { SceneDoc } from "./sceneDocSchema";

/** These tests run the solver's COLD-cache path (the pure wrap estimate): real troika measurement needs its worker and only runs in the app, where the export preamble pre-warms the same iteration sequence. */

const wide = computeFormat(FORMATS["16:9"]);
const frame = { cutout: { shape: "rounded-rect", side: "start" } } as unknown as FrameSpec;
const theme = {
  colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
  typography: {
    headline: { family: "Inter", weight: 700 },
    body: { family: "Inter", weight: 400 },
  },
} as unknown as Theme;

const docWith = (parts: Partial<SceneDoc>): SceneDoc => ({ version: 1, ...parts }) as SceneDoc;

describe("splitBullets", () => {
  it("splits on newlines, trims, drops blanks", () => {
    expect(splitBullets(" one \n\n two\n")).toEqual(["one", "two"]);
    expect(splitBullets(undefined)).toEqual([]);
    expect(splitBullets("")).toEqual([]);
  });
});

describe("solvePanelLayout bullets", () => {
  it("returns one height per bullet line, in order", () => {
    const doc = docWith({ text: { bullets: "alpha\nbeta\ngamma" } });
    const solution = solvePanelLayout(wide, frame, doc, theme);
    expect(solution.bulletHeights).toHaveLength(3);
    for (const h of solution.bulletHeights) {
      expect(h).toBeGreaterThan(0);
      expect(Number.isFinite(h)).toBe(true);
    }
  });

  it("budgets a wrapping bullet taller than a short one", () => {
    const long =
      "a genuinely long bullet line that cannot possibly fit the column in one go, ".repeat(3);
    const doc = docWith({ text: { bullets: `short\n${long}` } });
    const { bulletHeights } = solvePanelLayout(wide, frame, doc, theme);
    expect(bulletHeights[1]).toBeGreaterThan(bulletHeights[0]);
  });

  it("shrinks the fit when the bullet stack outgrows the column", () => {
    const few = solvePanelLayout(wide, frame, docWith({ text: { bullets: "one\ntwo" } }), theme);
    const lines = Array.from({ length: 14 }, (_, i) => `bullet line number ${i}`).join("\n");
    const many = solvePanelLayout(wide, frame, docWith({ text: { bullets: lines } }), theme);
    expect(many.fit).toBeLessThan(few.fit);
  });

  it("records a pending measurement per text block on a cold cache", () => {
    const doc = docWith({ text: { title: "Title", bullets: "one\ntwo" } });
    const { pending } = solvePanelLayout(wide, frame, doc, theme);
    const texts = new Set(pending.map((s) => s.text));
    expect(texts).toContain("Title");
    expect(texts).toContain("•  one");
    expect(texts).toContain("•  two");
  });

  it("honours the sidecar Size override in the measured spec, like the renderer", () => {
    const plain = solvePanelLayout(wide, frame, docWith({ text: { title: "Hello" } }), theme);
    const scaled = solvePanelLayout(
      wide,
      frame,
      docWith({ text: { title: "Hello" }, textStyle: { titleSize: 0.5 } }),
      theme,
    );
    const sizeOf = (s: typeof plain) => s.pending.find((p) => p.text === "Hello")?.fontSize ?? 0;
    expect(sizeOf(scaled)).toBeCloseTo(sizeOf(plain) * 0.5, 10);
  });

  it("ignores bullets when the frame does not claim the scene text", () => {
    const doc = docWith({ text: { bullets: "one\ntwo" } });
    const unclaimed = { ...frame, claimsSceneText: false } as FrameSpec;
    expect(solvePanelLayout(wide, unclaimed, doc, theme).bulletHeights).toEqual([]);
  });
});
