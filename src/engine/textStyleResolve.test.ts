import { describe, expect, it } from "vitest";
import { defaultTheme } from "../theme";
import type { V3 } from "../toolkit/types";
import type { SceneDoc } from "./sceneDocSchema";
import {
  resolveTokenFill,
  textStyleOffsetPosition,
  textStyleRotationRad,
  textStyleScaledSize,
  textStyleValue,
} from "./textStyleResolve";

const doc: SceneDoc = {
  version: 1,
  textStyle: {
    statSize: 1.5,
    statOffsetX: 0.2,
    statOffsetY: -0.1,
    statRotationDeg: 10,
    statColor: "#ff0000",
    onlyXOffsetX: 0.3,
  },
};

describe("textStyleValue", () => {
  it("reads the suffixed key and degrades without a doc or key", () => {
    expect(textStyleValue(doc, "stat", "Size")).toBe(1.5);
    expect(textStyleValue(doc, "stat", "Color")).toBe("#ff0000");
    expect(textStyleValue(doc, "stat", "Font")).toBeUndefined();
    expect(textStyleValue(doc, undefined, "Size")).toBeUndefined();
    expect(textStyleValue(null, "stat", "Size")).toBeUndefined();
    expect(textStyleValue({ version: 1 }, "stat", "Size")).toBeUndefined();
  });
});

describe("textStyleScaledSize", () => {
  it("multiplies only when the key holds a number", () => {
    expect(textStyleScaledSize(doc, "stat", 0.6)).toBe(0.6 * 1.5);
    expect(textStyleScaledSize(doc, "other", 0.6)).toBe(0.6);
    expect(textStyleScaledSize(doc, undefined, 0.6)).toBe(0.6);
    expect(textStyleScaledSize(null, "stat", 0.6)).toBe(0.6);
  });

  it("ignores a non-numeric value", () => {
    const bad: SceneDoc = { version: 1, textStyle: { statSize: "big" } };
    expect(textStyleScaledSize(bad, "stat", 0.6)).toBe(0.6);
  });
});

describe("textStyleOffsetPosition", () => {
  it("returns the ORIGINAL array when neither offset is set", () => {
    const position: V3 = [1, 2, 3];
    expect(textStyleOffsetPosition(doc, "other", position)).toBe(position);
    expect(textStyleOffsetPosition(doc, undefined, position)).toBe(position);
    expect(textStyleOffsetPosition(null, "stat", position)).toBe(position);
  });

  it("folds both offsets into the coded position", () => {
    expect(textStyleOffsetPosition(doc, "stat", [1, 2, 3])).toEqual([1.2, 1.9, 3]);
  });

  it("folds a lone offset leaving the other axis untouched", () => {
    expect(textStyleOffsetPosition(doc, "onlyX", [1, 2, 3])).toEqual([1.3, 2, 3]);
  });
});

describe("textStyleRotationRad", () => {
  it("converts degrees with AnimatedHeadline's sign and zeroes out cleanly", () => {
    expect(textStyleRotationRad(doc, "stat")).toBe((-10 * Math.PI) / 180);
    expect(textStyleRotationRad(doc, "other")).toBe(0);
    expect(textStyleRotationRad(null, "stat")).toBe(0);
    const zero: SceneDoc = { version: 1, textStyle: { statRotationDeg: 0 } };
    expect(textStyleRotationRad(zero, "stat")).toBe(0);
  });
});

describe("resolveTokenFill", () => {
  it("resolves the three tokens through the palette and passes raw fills through", () => {
    expect(resolveTokenFill(defaultTheme, "text")).toBe(defaultTheme.colors.text);
    expect(resolveTokenFill(defaultTheme, "muted")).toBe(defaultTheme.colors.muted);
    expect(resolveTokenFill(defaultTheme, "accent")).toBe(defaultTheme.colors.accent);
    expect(resolveTokenFill(defaultTheme, "#123456")).toBe("#123456");
    expect(resolveTokenFill(defaultTheme, "background")).toBe("background");
  });
});
