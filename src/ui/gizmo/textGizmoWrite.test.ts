import { describe, expect, it } from "vitest";
import { textOffsetWrite, textRotationWrite, textSizeWrite } from "./textGizmoWrite";

describe("textOffsetWrite", () => {
  it("rounds to 2dp", () => {
    expect(textOffsetWrite(0.4567)).toBe(0.46);
    expect(textOffsetWrite(-1.234)).toBe(-1.23);
  });

  it("clears at exactly zero, negative zero included", () => {
    expect(textOffsetWrite(0)).toBeUndefined();
    expect(textOffsetWrite(-0)).toBeUndefined();
    expect(textOffsetWrite(0.001)).toBeUndefined();
  });
});

describe("textSizeWrite", () => {
  it("rounds to whole percent", () => {
    expect(textSizeWrite(1.234)).toBe(1.23);
  });

  it("clears at exactly one", () => {
    expect(textSizeWrite(1)).toBeUndefined();
    expect(textSizeWrite(1.001)).toBeUndefined();
  });

  it("clamps to 0.01..10", () => {
    expect(textSizeWrite(-4)).toBe(0.01);
    expect(textSizeWrite(0)).toBe(0.01);
    expect(textSizeWrite(50)).toBe(10);
  });
});

describe("textRotationWrite", () => {
  it("rounds to 1dp", () => {
    expect(textRotationWrite(12.34)).toBe(12.3);
  });

  it("clears at upright, wrapped or not", () => {
    expect(textRotationWrite(0)).toBeUndefined();
    expect(textRotationWrite(360)).toBeUndefined();
    expect(textRotationWrite(-720)).toBeUndefined();
  });

  it("folds into (-180, 180]", () => {
    expect(textRotationWrite(-190)).toBe(170);
    expect(textRotationWrite(190)).toBe(-170);
    expect(textRotationWrite(180)).toBe(180);
  });
});
