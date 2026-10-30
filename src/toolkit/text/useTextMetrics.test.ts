import { describe, expect, it } from "vitest";
import type { TextMetrics } from "../../theme/fontMetrics";
import { fitFontSize, measuredText } from "./useTextMetrics";

const metrics = (width: number): TextMetrics => ({
  width,
  height: 1,
  ascent: 0.8,
  descent: 0.2,
  lines: 1,
});

describe("fitFontSize", () => {
  it("shrinks to fit and never grows", () => {
    expect(fitFontSize(metrics(4), 1, 2)).toBe(0.5);
    expect(fitFontSize(metrics(1), 1, 2)).toBe(1);
  });

  it("leaves the size alone with nothing to fit against", () => {
    expect(fitFontSize(metrics(0), 1, 2)).toBe(1);
    expect(fitFontSize(metrics(4), 1, 0)).toBe(1);
  });
});

describe("measuredText", () => {
  it("is null until the face has loaded", () => {
    expect(measuredText(null, "Launch", 0.6)).toBeNull();
  });

  it("is null for a 0-wide measure of real copy, the one a divide blows up on", () => {
    expect(measuredText(metrics(0), "Launch", 0.6)).toBeNull();
  });

  it("lets blank copy be honestly 0 wide", () => {
    expect(measuredText(metrics(0), "  ", 0.6)?.width).toBe(0);
  });

  it("hands back the fontSize prop that fits, not the resolved size", () => {
    const measured = measuredText(metrics(4), "Launch", 0.6);
    expect(measured?.fitFontSize(2)).toBeCloseTo(0.3);
    expect(measured?.fitFontSize(8)).toBe(0.6);
  });
});
