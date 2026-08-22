import { describe, expect, it } from "vitest";
import { defaultTheme } from "../theme";
import {
  compareChipDefaultColour,
  compareChipGroupKey,
  compareChipRowLabel,
  compareChipsEnabled,
  compareChipText,
  compareChipTextItems,
  compareChipTextKeyForSide,
  compareChipTextStyle,
  isCompareChipGroupKey,
  isCompareChipTextKey,
} from "./compareChipText";
import type { SceneDoc } from "./sceneDocSchema";

const withChips = (extra: Partial<SceneDoc> = {}): SceneDoc => ({
  version: 1,
  compare: { chrome: { chips: true } },
  ...extra,
});

describe("comparison chip text contract", () => {
  it("names the chrome keys, sides, labels and default fills", () => {
    expect(compareChipTextKeyForSide("a")).toBe("beforeLabel");
    expect(compareChipTextKeyForSide("b")).toBe("afterLabel");
    expect(compareChipRowLabel("beforeLabel")).toBe("Before label");
    expect(compareChipRowLabel("afterLabel")).toBe("After label");
    expect(compareChipDefaultColour("beforeLabel")).toBe("muted");
    expect(compareChipDefaultColour("afterLabel")).toBe("accent");
    expect(isCompareChipTextKey("beforeLabel")).toBe(true);
    expect(isCompareChipTextKey("title")).toBe(false);
    expect(isCompareChipGroupKey(compareChipGroupKey("afterLabel"))).toBe(true);
    expect(isCompareChipGroupKey("compare-chip:title")).toBe(false);
    expect(isCompareChipGroupKey("text")).toBe(false);
  });

  it("contributes items only while the comparison draws chips", () => {
    expect(compareChipsEnabled({ version: 1 })).toBe(false);
    expect(compareChipsEnabled({ version: 1, compare: { chrome: { line: { width: 4 } } } })).toBe(
      false,
    );
    expect(compareChipTextItems({ version: 1, text: { beforeLabel: "Old" } })).toEqual([]);
    expect(compareChipsEnabled(withChips())).toBe(true);
    expect(compareChipTextItems(withChips())).toEqual([
      { key: "beforeLabel", type: "subtitle", text: "Before" },
      { key: "afterLabel", type: "subtitle", text: "After" },
    ]);
  });

  it("prefers the sidecar copy over the renderer's fallback", () => {
    const doc = withChips({ text: { beforeLabel: "Pre-launch" } });
    expect(compareChipText(doc, "beforeLabel")).toBe("Pre-launch");
    expect(compareChipText(doc, "afterLabel")).toBe("After");
    expect(compareChipTextItems(doc)[0]).toEqual({
      key: "beforeLabel",
      type: "subtitle",
      text: "Pre-launch",
    });
  });

  it("resolves an unstyled chip to exactly its coded values", () => {
    const style = compareChipTextStyle({
      doc: withChips(),
      key: "beforeLabel",
      theme: defaultTheme,
      baseFontSize: 0.18,
      x: -1.33,
      y: 1.3,
    });

    expect(style).toEqual({
      fontRef: defaultTheme.typography.body,
      fontSize: 0.18,
      colour: defaultTheme.colors.muted,
      position: [-1.33, 1.3, 0],
    });
    expect(style.fontRef).toBe(defaultTheme.typography.body);
    expect(style.lineHeight).toBeUndefined();
    expect(style.rotationRad).toBeUndefined();
  });

  it("takes the after chip's own default fill", () => {
    expect(
      compareChipTextStyle({
        doc: withChips(),
        key: "afterLabel",
        theme: defaultTheme,
        baseFontSize: 0.13,
        x: 1,
        y: 0,
      }).colour,
    ).toBe(defaultTheme.colors.accent);
  });

  it("applies the sidecar overrides by the managed-text renderer's rules", () => {
    const style = compareChipTextStyle({
      doc: withChips({
        textStyle: {
          beforeLabelColor: "accent",
          beforeLabelFont: "Inter@600",
          beforeLabelSize: 1.5,
          beforeLabelOffsetX: 0.2,
          beforeLabelOffsetY: -0.1,
          beforeLabelLineHeight: 1.4,
          beforeLabelRotationDeg: 90,
        },
      }),
      key: "beforeLabel",
      theme: defaultTheme,
      baseFontSize: 0.18,
      x: 1,
      y: 2,
    });

    expect(style.colour).toBe(defaultTheme.colors.accent);
    expect(style.fontRef).toEqual({ family: "Inter", weight: 600 });
    expect(style.fontSize).toBeCloseTo(0.27, 10);
    expect(style.position).toEqual([1.2, 1.9, 0]);
    expect(style.lineHeight).toBe(1.4);
    expect(style.rotationRad).toBeCloseTo(-Math.PI / 2, 10);
  });

  it("passes a hex fill through and leaves a zero rotation off", () => {
    const style = compareChipTextStyle({
      doc: withChips({ textStyle: { afterLabelColor: "#ff8800", afterLabelRotationDeg: 0 } }),
      key: "afterLabel",
      theme: defaultTheme,
      baseFontSize: 0.18,
      x: 0,
      y: 0,
    });

    expect(style.colour).toBe("#ff8800");
    expect(style.rotationRad).toBeUndefined();
  });

  it("ignores malformed overrides rather than resolving them", () => {
    const style = compareChipTextStyle({
      doc: withChips({
        textStyle: {
          beforeLabelSize: "big",
          beforeLabelOffsetX: "2",
          beforeLabelColor: 5,
        } as never,
      }),
      key: "beforeLabel",
      theme: defaultTheme,
      baseFontSize: 0.18,
      x: -1,
      y: 1,
    });

    expect(style.fontSize).toBe(0.18);
    expect(style.position).toEqual([-1, 1, 0]);
    expect(style.colour).toBe(defaultTheme.colors.muted);
  });
});
