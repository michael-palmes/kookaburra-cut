import { describe, expect, it } from "vitest";
import { chartOffsetWrite, chartScaleWrite } from "./chartGizmoWrite";

describe("chartOffsetWrite", () => {
  it("adds the delta and rounds to 2dp", () => {
    expect(chartOffsetWrite(0.5, 0.234)).toBe(0.73);
    expect(chartOffsetWrite(-1, 0.002)).toBe(-1);
  });

  it("clamps to the resolver's ±20", () => {
    expect(chartOffsetWrite(19, 5)).toBe(20);
    expect(chartOffsetWrite(-19, -5)).toBe(-20);
  });
});

describe("chartScaleWrite", () => {
  it("multiplies and rounds to 2dp", () => {
    expect(chartScaleWrite(1, 1.234)).toBe(1.23);
    expect(chartScaleWrite(0.5, 2)).toBe(1);
  });

  it("clamps to the resolver's 0.2..3 rather than zeroing the chart", () => {
    expect(chartScaleWrite(1, 0)).toBe(0.2);
    expect(chartScaleWrite(1, -3)).toBe(0.2);
    expect(chartScaleWrite(2, 4)).toBe(3);
  });
});
