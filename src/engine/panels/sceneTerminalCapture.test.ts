import { describe, expect, it } from "vitest";
import { TERMINAL_FLAG_BOLD, TERMINAL_FLAG_UNDERLINE } from "./sceneTerminal";
import {
  type CaptureCell,
  type CaptureTerminal,
  captureTerminalSnapshot,
} from "./sceneTerminalCapture";

interface FakeCellSpec {
  ch?: string;
  width?: number;
  fg?: number | string | null;
  bg?: number | string | null;
  bold?: boolean;
  underline?: boolean;
}

function fakeCell(spec: FakeCellSpec): CaptureCell {
  const colour = (v: number | string | null | undefined) => ({
    isDefault: v === null || v === undefined,
    palette: typeof v === "number",
    value: typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v.slice(1), 16) : 0,
  });
  const fg = colour(spec.fg);
  const bg = colour(spec.bg);
  return {
    getChars: () => spec.ch ?? " ",
    getWidth: () => spec.width ?? 1,
    getFgColor: () => fg.value,
    getBgColor: () => bg.value,
    isFgDefault: () => fg.isDefault,
    isFgPalette: () => fg.palette,
    isBgDefault: () => bg.isDefault,
    isBgPalette: () => bg.palette,
    isBold: () => (spec.bold ? 1 : 0),
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => (spec.underline ? 1 : 0),
    isInverse: () => 0,
  };
}

function fakeTerminal(
  rows: FakeCellSpec[][],
  cols: number,
  cursor = { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0 },
): CaptureTerminal {
  return {
    cols,
    rows: rows.length,
    buffer: {
      active: {
        ...cursor,
        getLine: (y) => {
          const row = rows[y];
          if (!row) return undefined;
          return { getCell: (x) => (x < row.length ? fakeCell(row[x]) : fakeCell({})) };
        },
      },
    },
  };
}

const blank = {};

describe("captureTerminalSnapshot", () => {
  it("merges equal-styled cells into runs and trims trailing padding", () => {
    const term = fakeTerminal(
      [
        [
          { ch: "$", fg: 2, bold: true },
          { ch: " ", fg: 2, bold: true },
          { ch: "l", fg: 2, bold: true },
          { ch: "s", fg: 2, bold: true },
          { ch: " " },
          { ch: "-a", fg: "#0a141e" },
          blank,
          blank,
        ],
        [blank, blank],
      ],
      8,
    );
    expect(captureTerminalSnapshot(term).grid).toEqual([
      [
        ["$ ls", 2, null, TERMINAL_FLAG_BOLD],
        [" ", null, null, 0],
        ["-a", "#0a141e", null, 0],
      ],
      [],
    ]);
  });

  it("keeps styled trailing cells (underline or background) rather than trimming them", () => {
    const term = fakeTerminal([[{ ch: "a" }, { ch: " ", underline: true }, { ch: " ", bg: 4 }]], 3);
    expect(captureTerminalSnapshot(term).grid).toEqual([
      [
        ["a", null, null, 0],
        [" ", null, null, TERMINAL_FLAG_UNDERLINE],
        [" ", null, 4, 0],
      ],
    ]);
  });

  it("keeps a wide character once, skipping its continuation cell", () => {
    const term = fakeTerminal([[{ ch: "終", width: 2 }, { ch: "", width: 0 }, { ch: "x" }]], 3);
    expect(captureTerminalSnapshot(term).grid).toEqual([[["終x", null, null, 0]]]);
  });

  it("maps the cursor through baseY and drops it when scrolled out of the viewport", () => {
    const rows = [[blank], [blank], [blank]];
    const home = fakeTerminal(rows, 1, { viewportY: 10, baseY: 10, cursorX: 0, cursorY: 2 });
    expect(captureTerminalSnapshot(home).cursor).toEqual({ col: 0, row: 2 });
    const scrolled = fakeTerminal(rows, 1, { viewportY: 9, baseY: 10, cursorX: 0, cursorY: 1 });
    expect(captureTerminalSnapshot(scrolled).cursor).toEqual({ col: 0, row: 2 });
    const away = fakeTerminal(rows, 1, { viewportY: 0, baseY: 10, cursorX: 0, cursorY: 0 });
    expect(captureTerminalSnapshot(away).cursor).toBeUndefined();
  });
});
