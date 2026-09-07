/** Terminal scene content core: parses the sidecar `terminal` block (degrade-not-throw, the chart pattern) and resolves it into a fully defaulted `ResolvedSceneTerminal` so renderers never null-check fields. Pure (no clock reads, no three.js). The block is screen-locked overlay content drawn by the frame-panel pass; the interactive DOM overlay and the snapshot raster both derive their geometry from `sceneTerminalLayout` so they cannot drift. */

/** Logical cell metrics in em of `fontPx`, the contract shared by the panel layout, the raster baker and the DOM overlay's fit. */
export const TERMINAL_CELL_WIDTH_EM = 0.6;
export const TERMINAL_CELL_HEIGHT_EM = 1.35;

export const TERMINAL_COLS_MIN = 2;
export const TERMINAL_COLS_MAX = 400;
export const TERMINAL_ROWS_MIN = 2;
export const TERMINAL_ROWS_MAX = 200;
export const TERMINAL_FONT_PX_MIN = 6;
export const TERMINAL_FONT_PX_MAX = 48;

/** Style-run flag bits (`SceneTerminalRun[3]`). */
export const TERMINAL_FLAG_BOLD = 1;
export const TERMINAL_FLAG_ITALIC = 2;
export const TERMINAL_FLAG_UNDERLINE = 4;
export const TERMINAL_FLAG_DIM = 8;
export const TERMINAL_FLAG_INVERSE = 16;

export type SceneTerminalChromeStyle = "mac" | "bare";

/** A run colour: an ANSI palette index (0-255) or a `#rrggbb` hex; null/absent means the theme's default fg/bg. */
export type SceneTerminalColour = number | string;

/** One styled run of a snapshot row: text, then optional fg, bg and a flag bitfield. */
export type SceneTerminalRun = [
  text: string,
  fg?: SceneTerminalColour | null,
  bg?: SceneTerminalColour | null,
  flags?: number,
];

export interface SceneTerminalCursor {
  col: number;
  row: number;
  /** Absent is visible. */
  visible?: boolean;
}

export interface SceneDocTerminalSnapshot {
  /** Viewport rows as styled runs; short or missing rows read as blank cells. */
  grid: SceneTerminalRun[][];
  cursor?: SceneTerminalCursor;
  /** Baked raster under `assets/` (grid pixels only, chrome renders live): the export truth. */
  src?: string;
}

/** The sidecar `terminal` block as authored. Defaults are NOT applied here: `resolveSceneTerminal` owns them, so absence stays legible. */
export interface SceneDocTerminal {
  /** Terminal colour-scheme preset id; unknown ids render as `match-theme`. */
  theme?: string;
  chrome?: { style?: SceneTerminalChromeStyle; title?: string };
  cols?: number;
  rows?: number;
  /** Logical cell font size in px: raster density and the live overlay's type size, never panel geometry. */
  fontPx?: number;
  /** Session working directory (absolute or `~` path); absent is the workspace project folder. */
  startPath?: string;
  /** Pre-typed into the prompt, never auto-run (docs/decisions.md). */
  startCommand?: string;
  /** Frame-relative centre, -1..1 on both axes (the decoration convention). */
  position?: [number, number];
  /** Window width as a fraction of the frame width. */
  size?: number;
  snapshot?: SceneDocTerminalSnapshot;
}

export interface ResolvedSceneTerminal {
  theme: string;
  chrome: { style: SceneTerminalChromeStyle; title: string };
  cols: number;
  rows: number;
  fontPx: number;
  startPath: string | null;
  startCommand: string | null;
  position: [number, number];
  size: number;
  snapshot: SceneDocTerminalSnapshot | null;
}

export const TERMINAL_DEFAULTS = {
  theme: "match-theme",
  chromeStyle: "mac" as SceneTerminalChromeStyle,
  cols: 80,
  rows: 24,
  fontPx: 13,
  size: 0.55,
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function validColour(v: unknown): v is SceneTerminalColour {
  if (finiteNum(v)) return v >= 0 && v <= 255 && Number.isInteger(v);
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

function parseRun(raw: unknown): SceneTerminalRun | null {
  if (!Array.isArray(raw) || typeof raw[0] !== "string") return null;
  const run: SceneTerminalRun = [raw[0]];
  run[1] = validColour(raw[1]) ? raw[1] : null;
  run[2] = validColour(raw[2]) ? raw[2] : null;
  run[3] = finiteNum(raw[3]) ? raw[3] : 0;
  return run;
}

/** The pre-typed line stays reviewable at a glance; nothing legitimate approaches this. */
const COMMAND_MAX_CHARS = 512;

/** A pre-typed start command is a single reviewable line the presenter runs by hand (docs/decisions.md, "never auto-runs"): xterm turns `\n` into `\r` (Enter) and only wraps a paste in bracketed-paste markers once the shell has enabled the mode, so a newline in an imported pack's command could auto-run before the prompt is ready. Keep the first line only (never join two commands), drop control/format chars (ESC included, so a `\x1b[201~` can't close the wrapper) and cap the length. */
export function sanitizeStartCommand(raw: string): string {
  return raw
    .split(/[\r\n]/, 1)[0]
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, COMMAND_MAX_CHARS);
}

function parseSnapshot(raw: unknown, source: string): SceneDocTerminalSnapshot | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.grid)) {
    console.warn(`[sceneDoc] ${source}: terminal.snapshot needs a "grid" array, dropped`);
    return undefined;
  }
  const grid: SceneTerminalRun[][] = [];
  for (const rawRow of raw.grid as unknown[]) {
    if (!Array.isArray(rawRow)) {
      console.warn(`[sceneDoc] ${source}: terminal.snapshot row isn't an array, read as blank`);
      grid.push([]);
      continue;
    }
    const row: SceneTerminalRun[] = [];
    for (const rawRun of rawRow as unknown[]) {
      const run = parseRun(rawRun);
      if (run) row.push(run);
      else console.warn(`[sceneDoc] ${source}: terminal.snapshot run is malformed, dropped`);
    }
    grid.push(row);
  }
  const out: SceneDocTerminalSnapshot = { grid };
  if (isRecord(raw.cursor) && finiteNum(raw.cursor.col) && finiteNum(raw.cursor.row)) {
    out.cursor = {
      col: raw.cursor.col,
      row: raw.cursor.row,
      ...(raw.cursor.visible === false ? { visible: false } : {}),
    };
  } else if (raw.cursor !== undefined) {
    console.warn(`[sceneDoc] ${source}: terminal.snapshot.cursor is malformed, dropped`);
  }
  if (typeof raw.src === "string" && raw.src.length > 0) out.src = raw.src;
  else if (raw.src !== undefined) {
    console.warn(`[sceneDoc] ${source}: terminal.snapshot.src isn't a path, dropped`);
  }
  return out;
}

/** Field-level parse for the terminal block (the degrade-not-throw rule): every malformed field drops alone with a warning, and only a non-object drops the block whole. */
export function parseSceneTerminal(raw: unknown, source: string): SceneDocTerminal | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: terminal isn't an object, dropped`);
    return undefined;
  }
  const out: SceneDocTerminal = {};
  if (typeof raw.theme === "string" && raw.theme.trim().length > 0) out.theme = raw.theme.trim();
  else if (raw.theme !== undefined) {
    console.warn(`[sceneDoc] ${source}: terminal.theme isn't a preset id, dropped`);
  }
  if (isRecord(raw.chrome)) {
    const chrome: NonNullable<SceneDocTerminal["chrome"]> = {};
    if (raw.chrome.style === "mac" || raw.chrome.style === "bare") chrome.style = raw.chrome.style;
    else if (raw.chrome.style !== undefined) {
      console.warn(`[sceneDoc] ${source}: terminal.chrome.style isn't mac|bare, dropped`);
    }
    if (typeof raw.chrome.title === "string") chrome.title = raw.chrome.title;
    else if (raw.chrome.title !== undefined) {
      console.warn(`[sceneDoc] ${source}: terminal.chrome.title isn't a string, dropped`);
    }
    if (Object.keys(chrome).length > 0) out.chrome = chrome;
  } else if (raw.chrome !== undefined) {
    console.warn(`[sceneDoc] ${source}: terminal.chrome isn't an object, dropped`);
  }
  for (const key of ["cols", "rows", "fontPx", "size"] as const) {
    const value = raw[key];
    if (finiteNum(value)) out[key] = value;
    else if (value !== undefined) {
      console.warn(`[sceneDoc] ${source}: terminal.${key} isn't a finite number, dropped`);
    }
  }
  if (typeof raw.startPath === "string" && raw.startPath.length > 0) out.startPath = raw.startPath;
  else if (raw.startPath !== undefined) {
    console.warn(`[sceneDoc] ${source}: terminal.startPath isn't a non-empty string, dropped`);
  }
  if (typeof raw.startCommand === "string" && raw.startCommand.length > 0) {
    const command = sanitizeStartCommand(raw.startCommand);
    if (command.length > 0) out.startCommand = command;
    else console.warn(`[sceneDoc] ${source}: terminal.startCommand had no runnable text, dropped`);
  } else if (raw.startCommand !== undefined) {
    console.warn(`[sceneDoc] ${source}: terminal.startCommand isn't a non-empty string, dropped`);
  }
  if (Array.isArray(raw.position) && finiteNum(raw.position[0]) && finiteNum(raw.position[1])) {
    out.position = [raw.position[0], raw.position[1]];
  } else if (raw.position !== undefined) {
    console.warn(`[sceneDoc] ${source}: terminal.position isn't [x, y], dropped`);
  }
  if (raw.snapshot !== undefined) {
    const snapshot = parseSnapshot(raw.snapshot, source);
    if (snapshot) out.snapshot = snapshot;
  }
  return out;
}

/** Normalise a doc's terminal block: every default baked and every number clamped. Null when the doc has none (the null-for-legacy path). */
export function resolveSceneTerminal(
  doc: { terminal?: SceneDocTerminal } | undefined,
): ResolvedSceneTerminal | null {
  const raw = doc?.terminal;
  if (!raw) return null;
  const position = raw.position ?? [0, 0];
  return {
    theme: raw.theme ?? TERMINAL_DEFAULTS.theme,
    chrome: {
      style: raw.chrome?.style ?? TERMINAL_DEFAULTS.chromeStyle,
      title: raw.chrome?.title ?? "",
    },
    cols: Math.round(
      clamp(raw.cols ?? TERMINAL_DEFAULTS.cols, TERMINAL_COLS_MIN, TERMINAL_COLS_MAX),
    ),
    rows: Math.round(
      clamp(raw.rows ?? TERMINAL_DEFAULTS.rows, TERMINAL_ROWS_MIN, TERMINAL_ROWS_MAX),
    ),
    fontPx: clamp(
      raw.fontPx ?? TERMINAL_DEFAULTS.fontPx,
      TERMINAL_FONT_PX_MIN,
      TERMINAL_FONT_PX_MAX,
    ),
    startPath: raw.startPath ?? null,
    startCommand: raw.startCommand ?? null,
    position: [clamp(position[0], -1.5, 1.5), clamp(position[1], -1.5, 1.5)],
    size: clamp(raw.size ?? TERMINAL_DEFAULTS.size, 0.05, 1.5),
    snapshot: raw.snapshot ?? null,
  };
}

/** Horizontal grid padding, in cells per side. */
const PAD_X_CELLS = 1;
/** Vertical grid padding, in cell heights per edge. */
const PAD_Y_CELLS = 0.4;
/** The mac title bar, in cell heights. */
const TITLE_BAR_CELLS = 1.5;
/** Window corner radius, in cell heights. */
const RADIUS_CELLS = 0.55;
/** The mac bezel: the margin the square-cornered screen plane keeps inside the rounded body. */
const BEZEL_CELLS = 0.18;

interface RectCS {
  /** Centre, frame world units. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The panel geometry every consumer shares (renderer, gizmo, overlay, raster), in frame world units (y up, centre origin). Geometry is pure cell ratios of the authored width, so `fontPx` never moves the panel. */
export interface SceneTerminalFrameLayout {
  window: RectCS;
  /** 0 under `bare` chrome. */
  titleBarHeight: number;
  /** The square-cornered content plane (the full body under `bare` chrome). */
  screen: RectCS;
  /** The cell grid area inside the screen's padding; `left`/`top` are the first cell's outer corner. */
  grid: { left: number; top: number; width: number; height: number };
  cell: { width: number; height: number };
  radius: number;
  bezel: number;
}

export function sceneTerminalLayout(
  terminal: ResolvedSceneTerminal,
  frame: { width: number; height: number },
): SceneTerminalFrameLayout {
  const { cols, rows } = terminal;
  const width = terminal.size * frame.width;
  const cellW = width / (cols + 2 * PAD_X_CELLS);
  const cellH = cellW * (TERMINAL_CELL_HEIGHT_EM / TERMINAL_CELL_WIDTH_EM);
  const gridW = cols * cellW;
  const gridH = rows * cellH;
  const padY = PAD_Y_CELLS * cellH;
  const mac = terminal.chrome.style === "mac";
  const titleBarHeight = mac ? TITLE_BAR_CELLS * cellH : 0;
  const screenH = gridH + 2 * padY;
  const height = screenH + titleBarHeight;
  const cx = (terminal.position[0] * frame.width) / 2;
  const cy = (terminal.position[1] * frame.height) / 2;
  const radius = RADIUS_CELLS * cellH;
  const bezel = mac ? BEZEL_CELLS * cellH : 0;
  const screenTop = cy + height / 2 - titleBarHeight;
  return {
    window: { x: cx, y: cy, width, height },
    titleBarHeight,
    screen: {
      x: cx,
      y: screenTop - (screenH - bezel) / 2,
      width: width - 2 * bezel,
      height: screenH - bezel,
    },
    grid: { left: cx - gridW / 2, top: screenTop - padY, width: gridW, height: gridH },
    cell: { width: cellW, height: cellH },
    radius,
    bezel,
  };
}
