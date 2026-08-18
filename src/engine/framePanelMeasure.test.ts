import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { computeFormat, FORMATS } from "./format";
import {
  headerIconScale,
  managedPanelTextRegion,
  solvePanelLayout,
  splitBullets,
} from "./framePanelMeasure";
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

describe("headerIconScale", () => {
  it("is 1 without a sidecar override and reads the selected icon key", () => {
    expect(headerIconScale(undefined)).toBe(1);
    expect(headerIconScale(docWith({}))).toBe(1);
    expect(headerIconScale(docWith({ textStyle: { iconSize: 1.5 } }))).toBe(1.5);
    expect(headerIconScale(docWith({ textStyle: { frameIconSize: 1.75 } }), "frameIcon")).toBe(
      1.75,
    );
  });
});

describe("managedPanelTextRegion", () => {
  it("keeps grouped copy between the frame icon and chip", () => {
    const region = managedPanelTextRegion(1.2, -1.1, 0.35, 0.25);
    expect(region.top).toBeCloseTo(0.85, 10);
    expect(region.bottom).toBeCloseTo(-0.85, 10);
  });

  it("collapses safely when panel chrome consumes the region", () => {
    expect(managedPanelTextRegion(0.4, 0.1, 0.2, 0.4)).toEqual({
      top: 0.2,
      bottom: 0.2,
    });
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
    // Left-aligned bullets measure the text alone (the marker is its own node) plus the two indent probes.
    expect(texts).toContain("one");
    expect(texts).toContain("two");
    expect(texts).toContain("•  •");
    expect(texts).toContain("•");
  });

  it("keeps the one-string bullet and no indent under centre alignment", () => {
    const centred = { ...frame, textAlign: "center" } as FrameSpec;
    const doc = docWith({ text: { bullets: "one\ntwo" } });
    const solution = solvePanelLayout(wide, centred, doc, theme);
    const texts = new Set(solution.pending.map((s) => s.text));
    expect(texts).toContain("•  one");
    expect(texts).not.toContain("•  •");
    expect(solution.bulletIndent).toBe(0);
  });

  it("wraps left-aligned bullets inside the indent once the probes land", () => {
    // Cold, the probes are unmeasured, so the indent is zero and the wrap width is the full column.
    const doc = docWith({ text: { bullets: "one" } });
    const { pending, bulletIndent } = solvePanelLayout(wide, frame, doc, theme);
    expect(bulletIndent).toBe(0);
    const line = pending.find((s) => s.text === "one");
    expect(line?.maxWidth).toBeGreaterThan(0);
    expect(pending.find((s) => s.text === "•")?.maxWidth).toBe(Number.POSITIVE_INFINITY);
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

  it("honours the sidecar LineHeight override in the measured spec, like the renderer", () => {
    const plain = solvePanelLayout(wide, frame, docWith({ text: { title: "Hello" } }), theme);
    const spaced = solvePanelLayout(
      wide,
      frame,
      docWith({ text: { title: "Hello" }, textStyle: { titleLineHeight: 1.6 } }),
      theme,
    );
    const specOf = (s: typeof plain) => s.pending.find((p) => p.text === "Hello");
    expect(specOf(plain)?.lineHeight).toBeUndefined();
    expect(specOf(spaced)?.lineHeight).toBe(1.6);
    expect(spaced.titleH).toBeGreaterThan(plain.titleH);
  });

  it("reserves more of the column for a scaled header icon", () => {
    const iconFrame = { ...frame, icon: "🚀" } as FrameSpec;
    const lines = Array.from({ length: 14 }, (_, i) => `bullet line number ${i}`).join("\n");
    const plain = solvePanelLayout(wide, iconFrame, docWith({ text: { bullets: lines } }), theme);
    const big = solvePanelLayout(
      wide,
      iconFrame,
      docWith({ text: { bullets: lines }, textStyle: { iconSize: 2 } }),
      theme,
    );
    expect(big.fit).toBeLessThan(plain.fit);
  });

  it("ignores bullets when the frame does not claim the scene text", () => {
    const doc = docWith({ text: { bullets: "one\ntwo" } });
    const unclaimed = { ...frame, claimsSceneText: false } as FrameSpec;
    expect(solvePanelLayout(wide, unclaimed, doc, theme).bulletHeights).toEqual([]);
  });

  it("measures template-managed copy through the existing panel geometry", () => {
    const legacy = docWith({
      text: { title: "New title", subtitle: "New subtitle", bullets: "One\nTwo" },
    });
    const managed = docWith({
      text: { title: "Stale title", subtitle: "Stale subtitle", bullets: "Stale point" },
      managedText: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "New title" },
          { key: "subtitle", type: "subtitle", text: "New subtitle" },
          {
            key: "bullets",
            type: "bullets",
            points: [
              { key: "one", text: "One" },
              { key: "two", text: "Two" },
            ],
          },
        ],
      },
    });

    expect(solvePanelLayout(wide, frame, managed, theme)).toEqual(
      solvePanelLayout(wide, frame, legacy, theme),
    );
  });

  it("does not reserve legacy panel content behind a generic managed stack", () => {
    const framed = { ...frame, icon: "🚀" } as FrameSpec;
    const generic = docWith({
      text: { title: "Legacy title", subtitle: "Legacy subtitle", bullets: "Legacy point" },
      managedText: { items: [{ key: "managed", type: "title", text: "Managed" }] },
    });

    expect(solvePanelLayout(wide, framed, generic, theme)).toEqual(
      solvePanelLayout(wide, frame, docWith({}), theme),
    );
  });

  it("measures a dedicated frame icon independently from the scene icon", () => {
    const lines = Array.from({ length: 14 }, (_, i) => `bullet line number ${i}`).join("\n");
    const doc = docWith({
      textStyle: { iconSize: 0.5, frameIconSize: 2 },
      managedText: {
        layout: "template",
        items: [
          { key: "frameIcon", type: "icon", icon: "🚀" },
          { key: "icon", type: "icon", icon: "🪄" },
          {
            key: "bullets",
            type: "bullets",
            text: lines,
          },
        ],
      },
    });
    const dedicated = solvePanelLayout(wide, frame, doc, theme);
    const sceneSized = solvePanelLayout(
      wide,
      frame,
      docWith({ ...doc, textStyle: { iconSize: 0.5, frameIconSize: 0.5 } }),
      theme,
    );
    expect(dedicated.fit).toBeLessThan(sceneSized.fit);
  });

  it("keeps legacy template frame icons on the icon style key", () => {
    const lines = Array.from({ length: 14 }, (_, i) => `bullet line number ${i}`).join("\n");
    const legacyFrame = { ...frame, icon: "🚀" } as FrameSpec;
    const legacy = docWith({
      textStyle: { iconSize: 2 },
      managedText: {
        layout: "template",
        items: [
          { key: "icon", type: "icon", icon: "🚀" },
          { key: "bullets", type: "bullets", text: lines },
        ],
      },
    });
    const big = solvePanelLayout(wide, legacyFrame, legacy, theme);
    const small = solvePanelLayout(
      wide,
      legacyFrame,
      docWith({ ...legacy, textStyle: { iconSize: 0.5 } }),
      theme,
    );
    expect(big.fit).toBeLessThan(small.fit);
  });
});
