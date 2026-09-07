/** Bakes a terminal snapshot grid into PNG pixels: the write-once raster that becomes the export truth (the emoji raster-cache philosophy), drawn on an offscreen 2D canvas at capture time and never during export or preview rendering. Grid pixels only: the default background stays transparent so the live chrome's screen colour shows through and a surface re-theme re-bakes without a seam. */

import {
  type ResolvedSceneTerminal,
  TERMINAL_CELL_HEIGHT_EM,
  TERMINAL_CELL_WIDTH_EM,
  TERMINAL_FLAG_BOLD,
  TERMINAL_FLAG_DIM,
  TERMINAL_FLAG_INVERSE,
  TERMINAL_FLAG_ITALIC,
  TERMINAL_FLAG_UNDERLINE,
} from "./sceneTerminal";
import { type SceneTerminalColours, terminalRunColour } from "./sceneTerminalTheme";

/** Raster pixels per logical px, enough headroom for the 2x export frame. */
export const TERMINAL_RASTER_SCALE = 2;

/** The DOM overlay's exact stack, so the baked glyphs and the live xterm agree. */
export const TERMINAL_FONT_STACK = 'Menlo, ui-monospace, "SF Mono", monospace';

/** Enough East Asian Width to advance CJK and emoji by two cells, mirroring xterm's width-2 cells. */
export function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

interface PaintedCell {
  ch: string;
  col: number;
  row: number;
  span: number;
  fg: string;
  flags: number;
}

type Canvas2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function fontFor(flags: number, px: number): string {
  const italic = flags & TERMINAL_FLAG_ITALIC ? "italic " : "";
  const bold = flags & TERMINAL_FLAG_BOLD ? "bold " : "";
  return `${italic}${bold}${px}px ${TERMINAL_FONT_STACK}`;
}

function pngBytes(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/png" }).then(async (blob) => {
      return new Uint8Array(await blob.arrayBuffer());
    });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) reject(new Error("terminal raster: toBlob returned nothing"));
      else resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

/** Draw the snapshot grid (backgrounds, cursor block, glyphs, underlines) and return PNG bytes sized `cols x rows` cells at `fontPx x TERMINAL_RASTER_SCALE`. */
export async function rasterTerminalSnapshot(
  terminal: ResolvedSceneTerminal,
  colours: SceneTerminalColours,
): Promise<Uint8Array> {
  const { cols, rows, fontPx } = terminal;
  const grid = terminal.snapshot?.grid ?? [];
  const cursor = terminal.snapshot?.cursor ?? null;
  const fontSize = fontPx * TERMINAL_RASTER_SCALE;
  const cellW = TERMINAL_CELL_WIDTH_EM * fontSize;
  const cellH = TERMINAL_CELL_HEIGHT_EM * fontSize;
  const width = Math.max(1, Math.round(cols * cellW));
  const height = Math.max(1, Math.round(rows * cellH));

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d") as Canvas2d | null;
  if (!ctx) throw new Error("terminal raster: no 2d context");

  // Pass one: backgrounds, collecting each visible glyph for the text pass.
  const painted: PaintedCell[] = [];
  for (let r = 0; r < Math.min(rows, grid.length); r++) {
    let col = 0;
    for (const run of grid[r]) {
      const flags = run[3] ?? 0;
      const inverse = (flags & TERMINAL_FLAG_INVERSE) !== 0;
      const rawFg = terminalRunColour(run[1], colours, "fg") ?? colours.foreground;
      const rawBg = terminalRunColour(run[2], colours, "bg");
      const fg = inverse ? (rawBg ?? colours.screen) : rawFg;
      const bg = inverse ? rawFg : rawBg;
      for (const ch of run[0]) {
        if (col >= cols) break;
        const span = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
        if (bg) {
          ctx.fillStyle = bg;
          ctx.fillRect(col * cellW, r * cellH, span * cellW, cellH);
        }
        painted.push({ ch, col, row: r, span, fg, flags });
        col += span;
      }
      if (col >= cols) break;
    }
  }

  const cursorVisible = !!cursor && cursor.visible !== false;
  if (
    cursorVisible &&
    cursor.row >= 0 &&
    cursor.row < rows &&
    cursor.col >= 0 &&
    cursor.col < cols
  ) {
    ctx.fillStyle = colours.cursor;
    ctx.fillRect(cursor.col * cellW, cursor.row * cellH, cellW, cellH);
  }

  // Pass two: glyphs and underlines, the cursor cell's glyph knocked back to the screen colour.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const cell of painted) {
    const atCursor = cursorVisible && cursor.row === cell.row && cursor.col === cell.col;
    const colour = atCursor ? colours.screen : cell.fg;
    ctx.globalAlpha = cell.flags & TERMINAL_FLAG_DIM ? 0.55 : 1;
    if (cell.flags & TERMINAL_FLAG_UNDERLINE) {
      ctx.fillStyle = colour;
      ctx.fillRect(
        cell.col * cellW,
        cell.row * cellH + 0.88 * cellH,
        cell.span * cellW,
        Math.max(TERMINAL_RASTER_SCALE, 0.06 * fontSize),
      );
    }
    if (cell.ch !== " ") {
      ctx.font = fontFor(cell.flags, fontSize);
      ctx.fillStyle = colour;
      ctx.fillText(cell.ch, (cell.col + cell.span / 2) * cellW, (cell.row + 0.5) * cellH);
    }
  }
  ctx.globalAlpha = 1;

  return pngBytes(canvas);
}
