/** Serialises a live xterm viewport into the sidecar's styled-run snapshot grid. Structurally typed against xterm's buffer API (never importing it), so the module stays pure and unit-testable with a fake buffer; colours are stored mode-faithful (palette index, hex, or null for the theme default) so a later theme change re-colours the grid at bake time rather than staling it. */

import type { SceneDocTerminalSnapshot, SceneTerminalRun } from "./sceneTerminal";
import {
  TERMINAL_FLAG_BOLD,
  TERMINAL_FLAG_DIM,
  TERMINAL_FLAG_INVERSE,
  TERMINAL_FLAG_ITALIC,
  TERMINAL_FLAG_UNDERLINE,
} from "./sceneTerminal";

/** The slice of xterm's `IBufferCell` the capture reads. */
export interface CaptureCell {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgDefault(): boolean;
  isFgPalette(): boolean;
  isBgDefault(): boolean;
  isBgPalette(): boolean;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isInverse(): number;
}

export interface CaptureLine {
  getCell(x: number): CaptureCell | undefined;
}

/** The slice of xterm's `IBuffer`: `cursorY` is relative to `baseY` (the top of the bottom page), while the viewport may sit scrolled above it. */
export interface CaptureBuffer {
  viewportY: number;
  baseY: number;
  cursorX: number;
  cursorY: number;
  getLine(y: number): CaptureLine | undefined;
}

export interface CaptureTerminal {
  cols: number;
  rows: number;
  buffer: { active: CaptureBuffer };
}

function cellFlags(cell: CaptureCell): number {
  return (
    (cell.isBold() ? TERMINAL_FLAG_BOLD : 0) |
    (cell.isItalic() ? TERMINAL_FLAG_ITALIC : 0) |
    (cell.isUnderline() ? TERMINAL_FLAG_UNDERLINE : 0) |
    (cell.isDim() ? TERMINAL_FLAG_DIM : 0) |
    (cell.isInverse() ? TERMINAL_FLAG_INVERSE : 0)
  );
}

/** Palette cells keep their index, RGB cells become hex, defaults become null. */
function cellColour(cell: CaptureCell, side: "fg" | "bg"): number | string | null {
  const isDefault = side === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return null;
  const value = side === "fg" ? cell.getFgColor() : cell.getBgColor();
  const palette = side === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  if (palette) return value;
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** Trailing padding earns no run: blank text on the default background with no visible styling. */
function isTrailingBlank(run: SceneTerminalRun): boolean {
  const flags = run[3] ?? 0;
  return (
    run[0].trim().length === 0 &&
    (run[2] ?? null) === null &&
    (flags & (TERMINAL_FLAG_UNDERLINE | TERMINAL_FLAG_INVERSE)) === 0
  );
}

/** Serialise the visible viewport (never the scrollback) into rows of styled runs, merging equal-styled neighbours; blank cells inside a row keep their spaces so columns hold. The cursor is included only while it sits inside the captured viewport. */
export function captureTerminalSnapshot(term: CaptureTerminal): SceneDocTerminalSnapshot {
  const buffer = term.buffer.active;
  const grid: SceneTerminalRun[][] = [];
  for (let r = 0; r < term.rows; r++) {
    const line = buffer.getLine(buffer.viewportY + r);
    const row: SceneTerminalRun[] = [];
    if (line) {
      let run: SceneTerminalRun | null = null;
      for (let c = 0; c < term.cols; c++) {
        const cell = line.getCell(c);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        const fg = cellColour(cell, "fg");
        const bg = cellColour(cell, "bg");
        const flags = cellFlags(cell);
        if (run && run[1] === fg && run[2] === bg && run[3] === flags) {
          run[0] += chars;
        } else {
          run = [chars, fg, bg, flags];
          row.push(run);
        }
      }
      while (row.length > 0 && isTrailingBlank(row[row.length - 1])) row.pop();
    }
    grid.push(row);
  }
  const out: SceneDocTerminalSnapshot = { grid };
  const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
  if (cursorRow >= 0 && cursorRow < term.rows && buffer.cursorX < term.cols) {
    out.cursor = { col: buffer.cursorX, row: cursorRow };
  }
  return out;
}
