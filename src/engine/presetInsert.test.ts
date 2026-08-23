import { describe, expect, it } from "vitest";
import { presetInsertMove } from "./presetInsert";

describe("presetInsertMove", () => {
  it("appends without a move when the target is the end", () => {
    expect(presetInsertMove(3, 3)).toBeNull();
    expect(presetInsertMove(0, 0)).toBeNull();
  });

  it("walks the appended scene back to the target index", () => {
    expect(presetInsertMove(3, 0)).toEqual({ from: 3, to: 0 });
    expect(presetInsertMove(3, 2)).toEqual({ from: 3, to: 2 });
    expect(presetInsertMove(1, 0)).toEqual({ from: 1, to: 0 });
  });

  it("clamps a target past the end back to the append", () => {
    expect(presetInsertMove(2, 9)).toBeNull();
  });

  it("clamps a negative target to the front", () => {
    expect(presetInsertMove(2, -4)).toEqual({ from: 2, to: 0 });
  });

  it("truncates fractional inputs rather than minting fractional indices", () => {
    expect(presetInsertMove(3, 1.7)).toEqual({ from: 3, to: 1 });
  });
});
