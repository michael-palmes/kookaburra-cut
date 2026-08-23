import { describe, expect, it } from "vitest";
import { type CardBox, dropTargetIndex, gridInsertionIndex } from "./libraryReorder";

/** Two rows of two 100x60 cards, 20px apart, the layout a two-column grid produces. */
const boxes: CardBox[] = [
  { left: 0, top: 0, right: 100, bottom: 60 },
  { left: 120, top: 0, right: 220, bottom: 60 },
  { left: 0, top: 80, right: 100, bottom: 140 },
  { left: 120, top: 80, right: 220, bottom: 140 },
];

describe("gridInsertionIndex", () => {
  it("splits each card down its middle", () => {
    expect(gridInsertionIndex(boxes, 10, 30)).toBe(0);
    expect(gridInsertionIndex(boxes, 90, 30)).toBe(1);
    expect(gridInsertionIndex(boxes, 130, 30)).toBe(1);
    expect(gridInsertionIndex(boxes, 210, 30)).toBe(2);
  });

  it("reads rows top to bottom, including the gaps between them", () => {
    expect(gridInsertionIndex(boxes, 10, 70)).toBe(2);
    expect(gridInsertionIndex(boxes, 210, 110)).toBe(4);
  });

  it("lands at the end below every row, and at the start above them", () => {
    expect(gridInsertionIndex(boxes, 10, 400)).toBe(4);
    expect(gridInsertionIndex(boxes, 210, -40)).toBe(0);
    expect(gridInsertionIndex([], 10, 10)).toBe(0);
  });
});

describe("dropTargetIndex", () => {
  it("shifts a forward move back by the lifted card", () => {
    expect(dropTargetIndex(0, 3)).toBe(2);
    expect(dropTargetIndex(0, 1)).toBe(0);
  });

  it("leaves a backward move alone", () => {
    expect(dropTargetIndex(3, 1)).toBe(1);
    expect(dropTargetIndex(2, 2)).toBe(2);
  });
});
