import { describe, expect, it } from "vitest";
import {
  type ChartCsvData,
  isChartCsvError,
  parseChartCsv,
  parseChartNumber,
  parseDelimitedRows,
  serialiseChartCsv,
} from "./csv";

const data = (result: ReturnType<typeof parseChartCsv>): ChartCsvData => {
  if (isChartCsvError(result)) throw new Error(result.error);
  return result;
};

const error = (result: ReturnType<typeof parseChartCsv>): string => {
  if (!isChartCsvError(result)) throw new Error("expected a parse error");
  return result.error;
};

describe("parseDelimitedRows", () => {
  it("splits plain commas and drops the trailing newline", () => {
    expect(parseDelimitedRows("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps commas and newlines inside quotes, and unescapes doubled quotes", () => {
    expect(parseDelimitedRows('"Perth, WA","say ""hi"""\n')).toEqual([["Perth, WA", 'say "hi"']]);
    expect(parseDelimitedRows('"two\nlines",b')).toEqual([["two\nlines", "b"]]);
  });

  it("reads CRLF and lone CR line endings", () => {
    expect(parseDelimitedRows("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseDelimitedRows("a,b\rc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("detects tabs (the spreadsheet clipboard shape) ahead of commas", () => {
    expect(parseDelimitedRows("Q1\tQ2\n1,200\t2,400")).toEqual([
      ["Q1", "Q2"],
      ["1,200", "2,400"],
    ]);
  });

  it("strips a leading byte-order mark", () => {
    expect(parseDelimitedRows("﻿a,b")).toEqual([["a", "b"]]);
  });

  it("returns nothing for an empty string", () => {
    expect(parseDelimitedRows("")).toEqual([]);
  });
});

describe("parseChartNumber", () => {
  it("reads empty cells as zero", () => {
    expect(parseChartNumber("")).toBe(0);
    expect(parseChartNumber("   ")).toBe(0);
  });

  it("strips grouping, currency and percent marks", () => {
    expect(parseChartNumber("1,234.5")).toBe(1234.5);
    expect(parseChartNumber("$1,200")).toBe(1200);
    expect(parseChartNumber("42%")).toBe(42);
    expect(parseChartNumber(" -3.25 ")).toBe(-3.25);
  });

  it("reads accountancy parentheses as negative", () => {
    expect(parseChartNumber("(1,500)")).toBe(-1500);
  });

  it("rejects text", () => {
    expect(parseChartNumber("n/a")).toBeNull();
    expect(parseChartNumber("-")).toBeNull();
    expect(parseChartNumber("12ab")).toBeNull();
  });
});

describe("parseChartCsv", () => {
  it("reads the header row as categories and the first column as series names", () => {
    const parsed = data(parseChartCsv("Region,Q1,Q2,Q3\nNorth,10,20,30\nSouth,5,6,7\n"));
    expect(parsed.categories).toEqual(["Q1", "Q2", "Q3"]);
    expect(parsed.series).toEqual([
      { name: "North", values: [10, 20, 30] },
      { name: "South", values: [5, 6, 7] },
    ]);
  });

  it("keeps quoted commas in labels", () => {
    const parsed = data(parseChartCsv('"","Perth, WA","Broome, WA"\n"Sales, net",10,20\n'));
    expect(parsed.categories).toEqual(["Perth, WA", "Broome, WA"]);
    expect(parsed.series[0].name).toBe("Sales, net");
  });

  it("pads ragged rows with zeroes and reads empty cells as zero", () => {
    const parsed = data(parseChartCsv("Region,Q1,Q2,Q3\r\nNorth,10\r\nSouth,1,,3\r\n"));
    expect(parsed.series).toEqual([
      { name: "North", values: [10, 0, 0] },
      { name: "South", values: [1, 0, 3] },
    ]);
  });

  it("names unlabelled categories and series", () => {
    const parsed = data(parseChartCsv(",,Q2\n,1,2\n"));
    expect(parsed.categories).toEqual(["Category 1", "Q2"]);
    expect(parsed.series[0].name).toBe("Series 1");
  });

  it("ignores blank lines anywhere in the file", () => {
    const parsed = data(parseChartCsv("\nRegion,Q1\n\nNorth,10\n\n"));
    expect(parsed.series).toEqual([{ name: "North", values: [10] }]);
  });

  it("fails the import on the first non-numeric cell, naming it", () => {
    expect(error(parseChartCsv("Region,Q1,Q2\nNorth,10,tbc\n"))).toBe('C2 is not a number: "tbc"');
  });

  it("explains an empty or headerless file", () => {
    expect(error(parseChartCsv(""))).toMatch(/empty/);
    expect(error(parseChartCsv("Region\nNorth\n"))).toMatch(/first row/);
    expect(error(parseChartCsv("Region,Q1,Q2\n"))).toMatch(/series row/);
  });
});

describe("serialiseChartCsv", () => {
  it("round-trips through the parser", () => {
    const source: ChartCsvData = {
      categories: ["Perth, WA", 'The "big" one'],
      series: [
        { name: "North", values: [10, -2.5] },
        { name: "South", values: [0, 7] },
      ],
    };
    expect(serialiseChartCsv(source)).toBe(
      ',"Perth, WA","The ""big"" one"\nNorth,10,-2.5\nSouth,0,7\n',
    );
    expect(data(parseChartCsv(serialiseChartCsv(source)))).toEqual(source);
  });
});
