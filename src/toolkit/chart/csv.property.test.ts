import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isChartCsvError, parseChartCsv, serialiseChartCsv } from "./csv";

/** A grid label as the parser keeps it: trimmed and non-empty. */
const label = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((text) => text.trim())
  .filter((text) => text.length > 0);

/** A finite cell value; -0 prints as "0", so it reads back as +0. */
const value = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .map((v) => (Object.is(v, -0) ? 0 : v));

const table = fc.integer({ min: 1, max: 6 }).chain((width) =>
  fc.record({
    categories: fc.array(label, { minLength: width, maxLength: width }),
    series: fc.array(
      fc.record({ name: label, values: fc.array(value, { minLength: width, maxLength: width }) }),
      { minLength: 1, maxLength: 6 },
    ),
  }),
);

describe("chart CSV", () => {
  it("parses what it serialises", () => {
    fc.assert(
      fc.property(table, (data) => {
        expect(parseChartCsv(serialiseChartCsv(data))).toEqual(data);
      }),
    );
  });

  it("never throws on arbitrary text and keeps every series as wide as the categories", () => {
    const text = fc.oneof(
      fc.string(),
      fc.string({ unit: "binary" }),
      fc.stringMatching(/^[\w ,;\t"\r\n$%().+-]{0,80}$/),
    );
    fc.assert(
      fc.property(text, (text) => {
        const result = parseChartCsv(text);
        if (isChartCsvError(result)) {
          expect(result.error.length).toBeGreaterThan(0);
          return;
        }
        expect(result.categories.length).toBeGreaterThan(0);
        for (const category of result.categories) expect(category.length).toBeGreaterThan(0);
        for (const series of result.series) {
          expect(series.name.length).toBeGreaterThan(0);
          expect(series.values).toHaveLength(result.categories.length);
          for (const v of series.values) expect(Number.isFinite(v)).toBe(true);
        }
      }),
    );
  });
});
