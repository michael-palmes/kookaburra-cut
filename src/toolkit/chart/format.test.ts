import { describe, expect, it } from "vitest";
import { CHART_DEFAULT_FORMAT, formatChartValue } from "./format";
import type { ChartValueFormat } from "./types";

const fmt = (parts: Partial<ChartValueFormat> = {}): ChartValueFormat => ({
  ...CHART_DEFAULT_FORMAT,
  ...parts,
});

describe("decimals", () => {
  it("auto trims trailing zeros and stops at two places", () => {
    expect(formatChartValue(0, fmt())).toBe("0");
    expect(formatChartValue(3, fmt())).toBe("3");
    expect(formatChartValue(3.1, fmt())).toBe("3.1");
    expect(formatChartValue(3.10000001, fmt())).toBe("3.1");
    expect(formatChartValue(7.34159, fmt())).toBe("7.34");
    expect(formatChartValue(0.001, fmt())).toBe("0");
  });

  it("fixed decimals keep their zeros", () => {
    expect(formatChartValue(3, fmt({ decimals: 2 }))).toBe("3.00");
    expect(formatChartValue(7.34159, fmt({ decimals: 3 }))).toBe("7.342");
    expect(formatChartValue(1234.5, fmt({ decimals: 0 }))).toBe("1,235");
  });

  it("clamps decimals to 0..4", () => {
    expect(formatChartValue(1.23456789, fmt({ decimals: 9 }))).toBe("1.2346");
    expect(formatChartValue(1.6, fmt({ decimals: -3 }))).toBe("2");
  });
});

describe("separator", () => {
  it("groups thousands with a comma by default", () => {
    expect(formatChartValue(1234.5, fmt())).toBe("1,234.5");
    expect(formatChartValue(1234567, fmt())).toBe("1,234,567");
    expect(formatChartValue(999, fmt())).toBe("999");
    expect(formatChartValue(1000, fmt())).toBe("1,000");
  });

  it("drops the comma when switched off", () => {
    expect(formatChartValue(1234567, fmt({ separator: false }))).toBe("1234567");
  });

  it("never mangles a value too large for plain notation", () => {
    expect(formatChartValue(1e21, fmt())).toBe("1e+21");
  });
});

describe("affixes", () => {
  it("wraps the digits with prefix and suffix", () => {
    expect(formatChartValue(45.5, fmt({ prefix: "$" }))).toBe("$45.5");
    expect(formatChartValue(45.5, fmt({ suffix: "%" }))).toBe("45.5%");
    expect(formatChartValue(1200, fmt({ prefix: "$", suffix: " AUD" }))).toBe("$1,200 AUD");
  });

  it("puts the sign before the prefix", () => {
    expect(formatChartValue(-1234.5, fmt({ prefix: "$" }))).toBe("-$1,234.5");
    expect(formatChartValue(-1200000, fmt({ prefix: "$", compact: true }))).toBe("-$1.2M");
  });
});

describe("negatives and zero", () => {
  it("keeps the sign on real negatives", () => {
    expect(formatChartValue(-7, fmt())).toBe("-7");
    expect(formatChartValue(-0.25, fmt())).toBe("-0.25");
  });

  it("never prints a negative zero", () => {
    expect(formatChartValue(-0.4, fmt({ decimals: 0 }))).toBe("0");
    expect(formatChartValue(-0.001, fmt())).toBe("0");
    expect(formatChartValue(-0, fmt())).toBe("0");
  });
});

describe("compact", () => {
  it("switches unit at each thousand", () => {
    expect(formatChartValue(999, fmt({ compact: true }))).toBe("999");
    expect(formatChartValue(1000, fmt({ compact: true }))).toBe("1k");
    expect(formatChartValue(1200, fmt({ compact: true }))).toBe("1.2k");
    expect(formatChartValue(1250, fmt({ compact: true }))).toBe("1.3k");
    expect(formatChartValue(1e6, fmt({ compact: true }))).toBe("1M");
    expect(formatChartValue(3400000, fmt({ compact: true }))).toBe("3.4M");
    expect(formatChartValue(1e9, fmt({ compact: true }))).toBe("1B");
    expect(formatChartValue(1234567890, fmt({ compact: true }))).toBe("1.2B");
  });

  it("rolls a rounded mantissa up to the next unit", () => {
    expect(formatChartValue(999.96, fmt({ compact: true }))).toBe("1k");
    expect(formatChartValue(999499, fmt({ compact: true }))).toBe("999.5k");
    expect(formatChartValue(999999, fmt({ compact: true }))).toBe("1M");
    expect(formatChartValue(999999999, fmt({ compact: true }))).toBe("1B");
    expect(formatChartValue(-999999, fmt({ compact: true }))).toBe("-1M");
  });

  it("honours fixed decimals, and separates past a thousand billion", () => {
    expect(formatChartValue(1200, fmt({ compact: true, decimals: 0 }))).toBe("1k");
    expect(formatChartValue(1600, fmt({ compact: true, decimals: 0 }))).toBe("2k");
    expect(formatChartValue(1250, fmt({ compact: true, decimals: 2 }))).toBe("1.25k");
    expect(formatChartValue(1e12, fmt({ compact: true }))).toBe("1,000B");
  });
});

describe("degenerate input", () => {
  it("reads a broken number as zero, like the layout does", () => {
    expect(formatChartValue(Number.NaN, fmt())).toBe("0");
    expect(formatChartValue(Number.POSITIVE_INFINITY, fmt({ prefix: "$" }))).toBe("$0");
    expect(formatChartValue(Number.NEGATIVE_INFINITY, fmt())).toBe("0");
  });

  it("formats with no options at all", () => {
    expect(formatChartValue(1234)).toBe("1,234");
  });
});
