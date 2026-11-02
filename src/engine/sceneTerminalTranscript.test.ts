import { describe, expect, it } from "vitest";
import { terminalSnapshotStale } from "./sceneTerminal";
import { landTranscriptSnapshot, layoutTranscript } from "./sceneTerminalTranscript";

const text = (grid: ReturnType<typeof layoutTranscript>["grid"]) =>
  grid.map((row) => row.map((run) => run[0]).join(""));

describe("layoutTranscript", () => {
  it("lays plain lines out top-down with the cursor after the last character", () => {
    const { grid, cursor } = layoutTranscript("$ ls\nREADME.md\n$ ", 20, 5);
    expect(text(grid)).toEqual(["$ ls", "README.md", "$"]);
    expect(cursor).toEqual({ col: 2, row: 2 });
  });

  it("puts the cursor on the new line after a trailing newline", () => {
    expect(layoutTranscript("done\n", 20, 5).cursor).toEqual({ col: 0, row: 1 });
  });

  it("wraps at cols, and only when another character follows", () => {
    const exact = layoutTranscript("abcd", 4, 3);
    expect(text(exact.grid)).toEqual(["abcd"]);
    expect(exact.cursor).toEqual({ col: 3, row: 0 });
    const over = layoutTranscript("abcde", 4, 3);
    expect(text(over.grid)).toEqual(["abcd", "e"]);
    expect(over.cursor).toEqual({ col: 1, row: 1 });
    const newline = layoutTranscript("abcd\nef", 4, 3);
    expect(text(newline.grid)).toEqual(["abcd", "ef"]);
  });

  it("keeps the last rows on overflow", () => {
    const { grid, cursor } = layoutTranscript("1\n2\n3\n4\n5", 4, 3);
    expect(text(grid)).toEqual(["3", "4", "5"]);
    expect(cursor).toEqual({ col: 1, row: 2 });
  });

  it("honours SGR colours and attributes as styled runs", () => {
    const { grid } = layoutTranscript(
      "\u001b[32mok\u001b[0m plain \u001b[1;4;91mfail\u001b[22;24;39m end",
      40,
      2,
    );
    expect(grid[0]).toEqual([
      ["ok", 2, null, 0],
      [" plain ", null, null, 0],
      ["fail", 9, null, 5],
      [" end", null, null, 0],
    ]);
  });

  it("reads 256-colour, truecolour, background and inverse forms", () => {
    const { grid } = layoutTranscript(
      "\u001b[38;5;208ma\u001b[48;2;16;32;255mb\u001b[0;7;2;3mc\u001b[m",
      10,
      2,
    );
    expect(grid[0]).toEqual([
      ["a", 208, null, 0],
      ["b", 208, "#1020ff", 0],
      ["c", null, null, 8 | 2 | 16],
    ]);
  });

  it("keeps background-only blanks at the end of a row and trims plain ones", () => {
    expect(layoutTranscript("a  ", 10, 2).grid[0]).toEqual([["a", null, null, 0]]);
    expect(layoutTranscript("\u001b[41m  ", 10, 2).grid[0]).toEqual([["  ", null, 1, 0]]);
  });

  it("takes the spelled-out escapes a person can type", () => {
    for (const esc of ["\\e[", "\\x1b[", "\\033[", "\\u001b["]) {
      expect(layoutTranscript(`${esc}31mred`, 10, 2).grid[0]).toEqual([["red", 1, null, 0]]);
    }
  });

  it("strips control characters and every other escape sequence", () => {
    const { grid, cursor } = layoutTranscript(
      "a\u0007\u0000b\u001b[2J\u001b[10;10Hc\u001b]0;title\u0007d\u001b]8;;https://x\u001b\\e\u001b(Bf\u009b31mg​h",
      40,
      4,
    );
    expect(text(grid)).toEqual(["abcdef31mgh"]);
    expect(cursor).toEqual({ col: 11, row: 0 });
  });

  it("drops an unterminated escape and a malformed colour without throwing", () => {
    expect(text(layoutTranscript("ok\u001b[31", 10, 2).grid)).toEqual(["ok"]);
    expect(text(layoutTranscript("ok\u001b]0;title", 10, 2).grid)).toEqual(["ok"]);
    expect(layoutTranscript("\u001b[38;5;999mx", 10, 2).grid[0]).toEqual([["x", null, null, 0]]);
    expect(layoutTranscript("\u001b[4:3mx", 10, 2).grid[0]).toEqual([["x", null, null, 0]]);
  });

  it("follows carriage return, backspace and tab stops", () => {
    expect(text(layoutTranscript("50%\r100%", 10, 2).grid)).toEqual(["100%"]);
    expect(text(layoutTranscript("ab\bc", 10, 2).grid)).toEqual(["ac"]);
    expect(text(layoutTranscript("a\tb", 20, 2).grid)).toEqual(["a       b"]);
    expect(text(layoutTranscript("a\r\nb", 10, 2).grid)).toEqual(["a", "b"]);
  });

  it("gives wide characters two cells and wraps them whole", () => {
    const { grid, cursor } = layoutTranscript("ab漢字", 4, 3);
    expect(text(grid)).toEqual(["ab漢", "字"]);
    expect(cursor).toEqual({ col: 2, row: 1 });
    expect(text(layoutTranscript("漢\rx", 4, 2).grid)).toEqual(["x"]);
  });

  it("composes decomposed accents into one cell and drops other marks", () => {
    expect(layoutTranscript("éx", 4, 2).cursor).toEqual({ col: 2, row: 0 });
    expect(text(layoutTranscript("q́", 4, 2).grid)).toEqual(["q"]);
  });

  it("gives an empty grid for an empty transcript", () => {
    expect(layoutTranscript("", 10, 2)).toEqual({ grid: [], cursor: { col: 0, row: 0 } });
  });

  it("gives the same grid for the same text", () => {
    const sample = "\u001b[32m$ pnpm test\u001b[0m\n✓ 42 passed\n";
    expect(layoutTranscript(sample, 80, 24)).toEqual(layoutTranscript(sample, 80, 24));
  });
});

describe("landTranscriptSnapshot", () => {
  it("settles the block, so nothing is stale after an edit's one write", () => {
    const terminal = { cols: 20, rows: 4, transcript: "$ ls" };
    landTranscriptSnapshot(terminal, "01-demo");
    expect(terminalSnapshotStale(terminal)).toBe(false);
    expect(terminal).toMatchObject({
      snapshot: { src: "assets/terminal-01-demo.png", transcript: "$ ls" },
    });
  });

  it("leaves a captured grid alone", () => {
    const snapshot = { grid: [], src: "assets/x.png" };
    const terminal = { snapshot };
    landTranscriptSnapshot(terminal, "01-demo");
    expect(terminal.snapshot).toBe(snapshot);
  });
});
