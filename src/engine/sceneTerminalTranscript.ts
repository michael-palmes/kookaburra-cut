import type {
  SceneDocTerminal,
  SceneDocTerminalSnapshot,
  SceneTerminalColour,
  SceneTerminalRun,
} from "./sceneTerminal";
import {
  resolveSceneTerminal,
  TERMINAL_FLAG_BOLD,
  TERMINAL_FLAG_DIM,
  TERMINAL_FLAG_INVERSE,
  TERMINAL_FLAG_ITALIC,
  TERMINAL_FLAG_UNDERLINE,
  terminalSnapshotSrc,
} from "./sceneTerminal";
import { isWideCodePoint } from "./sceneTerminalWidth";

/** Lays a plain-text transcript out into a terminal's cols x rows grid with terminal semantics: wrap at cols, keep the last rows, the cursor after the last character. ANSI SGR colours and attributes are honoured; every other control sequence and control character is dropped, so nothing here can move the cursor or reach past the grid. Pure: the same text always gives the same grid. */

const TAB_STOP = 8;

interface Style {
  fg: SceneTerminalColour | null;
  bg: SceneTerminalColour | null;
  flags: number;
}

const PLAIN: Style = { fg: null, bg: null, flags: 0 };

interface Cell extends Style {
  ch: string;
}

/** A blank that was never written; `WIDE_TAIL` is the second half of a two-cell character. */
const WIDE_TAIL = "";

/** The text forms of ESC, so a colour can be typed by hand in the inspector. */
const SPELLED_ESC = /\\(?:e|x1[bB]|033|u001[bB])\[/g;

const DROPPED = /[\p{Cc}\p{Cf}\p{Cs}\p{Mn}\p{Me}\p{Zl}\p{Zp}]/u;

/** The colour a `38`/`48` sub-sequence names and how many parameters it used, or null for a form this does not read. */
function extendedColour(
  params: readonly number[],
  at: number,
): { colour: SceneTerminalColour; used: number } | null {
  const mode = params[at + 1];
  if (mode === 5) {
    const index = params[at + 2];
    return index >= 0 && index <= 255 ? { colour: index, used: 3 } : null;
  }
  if (mode === 2) {
    const channels = params.slice(at + 2, at + 5);
    if (channels.length !== 3 || channels.some((c) => !(c >= 0 && c <= 255))) return null;
    const hex = channels.map((c) => c.toString(16).padStart(2, "0")).join("");
    return { colour: `#${hex}`, used: 5 };
  }
  return null;
}

function applySgr(style: Style, params: readonly number[]): Style {
  let { fg, bg, flags } = style;
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 0) ({ fg, bg, flags } = PLAIN);
    else if (code === 1) flags |= TERMINAL_FLAG_BOLD;
    else if (code === 2) flags |= TERMINAL_FLAG_DIM;
    else if (code === 3) flags |= TERMINAL_FLAG_ITALIC;
    else if (code === 4) flags |= TERMINAL_FLAG_UNDERLINE;
    else if (code === 7) flags |= TERMINAL_FLAG_INVERSE;
    else if (code === 22) flags &= ~(TERMINAL_FLAG_BOLD | TERMINAL_FLAG_DIM);
    else if (code === 23) flags &= ~TERMINAL_FLAG_ITALIC;
    else if (code === 24) flags &= ~TERMINAL_FLAG_UNDERLINE;
    else if (code === 27) flags &= ~TERMINAL_FLAG_INVERSE;
    else if (code >= 30 && code <= 37) fg = code - 30;
    else if (code === 39) fg = null;
    else if (code >= 40 && code <= 47) bg = code - 40;
    else if (code === 49) bg = null;
    else if (code >= 90 && code <= 97) fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const extended = extendedColour(params, i);
      if (!extended) break;
      if (code === 38) fg = extended.colour;
      else bg = extended.colour;
      i += extended.used - 1;
    }
  }
  return { fg, bg, flags };
}

/** A colon or other private form reads as nothing, not as a stray reset. */
function sgrParams(body: string): number[] | null {
  if (!/^[0-9;]*$/.test(body)) return null;
  return body.split(";").map((p) => (p === "" ? 0 : Number(p)));
}

/** Where the escape sequence starting at `esc` ends, and its SGR body when it is one. */
function readEscape(text: string, esc: number): { next: number; sgr: string | null } {
  const kind = text[esc + 1];
  if (kind === undefined) return { next: text.length, sgr: null };
  if (kind === "[") {
    let i = esc + 2;
    while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x3f) i++;
    if (i >= text.length) return { next: text.length, sgr: null };
    return { next: i + 1, sgr: text[i] === "m" ? text.slice(esc + 2, i) : null };
  }
  // OSC, DCS, SOS, PM and APC strings run to BEL or ST.
  if ("]PX^_".includes(kind)) {
    for (let i = esc + 2; i < text.length; i++) {
      if (text[i] === "\u0007") return { next: i + 1, sgr: null };
      if (text[i] === "\u001b" && text[i + 1] === "\\") return { next: i + 2, sgr: null };
    }
    return { next: text.length, sgr: null };
  }
  let i = esc + 1;
  while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++;
  return { next: Math.min(text.length, i + 1), sgr: null };
}

function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.flags === b.flags;
}

function rowRuns(row: (Cell | null)[]): SceneTerminalRun[] {
  let end = row.length;
  while (end > 0) {
    const cell = row[end - 1];
    if (cell && (cell.ch !== " " || cell.bg !== null || cell.flags !== 0)) break;
    end--;
  }
  const runs: SceneTerminalRun[] = [];
  let open: { text: string; style: Style } | null = null;
  for (let col = 0; col < end; col++) {
    const cell = row[col];
    if (cell?.ch === WIDE_TAIL) continue;
    const ch = cell?.ch ?? " ";
    const style = cell ?? PLAIN;
    if (open && sameStyle(open.style, style)) {
      open.text += ch;
      continue;
    }
    if (open) runs.push([open.text, open.style.fg, open.style.bg, open.style.flags]);
    open = { text: ch, style };
  }
  if (open) runs.push([open.text, open.style.fg, open.style.bg, open.style.flags]);
  return runs;
}

/** The snapshot grid and cursor a transcript lays out to, in the parsed sidecar form. */
export function layoutTranscript(
  transcript: string,
  cols: number,
  rows: number,
): Pick<SceneDocTerminalSnapshot, "grid" | "cursor"> {
  const text = transcript.replace(SPELLED_ESC, "\u001b[").normalize("NFC");
  const newRow = (): (Cell | null)[] => new Array(cols).fill(null);
  const screen = [newRow()];
  let row = 0;
  let col = 0;
  // A write into the last column waits here: the wrap happens only if another character follows.
  let pendingWrap = false;
  let style = PLAIN;

  const lineFeed = () => {
    if (row === rows - 1) screen.shift();
    else row++;
    if (!screen[row]) screen[row] = newRow();
  };
  const put = (at: number, cell: Cell | null) => {
    const line = screen[row];
    if (line[at]?.ch === WIDE_TAIL) line[at - 1] = null;
    else if (line[at + 1]?.ch === WIDE_TAIL) line[at + 1] = null;
    line[at] = cell;
  };
  const write = (ch: string) => {
    const span = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (span > cols) return;
    if (pendingWrap || col + span > cols) {
      col = 0;
      pendingWrap = false;
      lineFeed();
    }
    put(col, { ch, ...style });
    if (span === 2) put(col + 1, { ch: WIDE_TAIL, ...style });
    col += span;
    if (col === cols) {
      col = cols - 1;
      pendingWrap = true;
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0xfffd);
    if (ch === "\u001b") {
      const { next, sgr } = readEscape(text, i);
      const params = sgr === null ? null : sgrParams(sgr);
      if (params) style = applySgr(style, params);
      i = next;
      continue;
    }
    i += ch.length;
    if (ch === "\n") {
      col = 0;
      pendingWrap = false;
      lineFeed();
    } else if (ch === "\r") {
      col = 0;
      pendingWrap = false;
    } else if (ch === "\b") {
      col = Math.max(0, col - 1);
      pendingWrap = false;
    } else if (ch === "\t") {
      col = Math.min(cols - 1, (Math.floor(col / TAB_STOP) + 1) * TAB_STOP);
      pendingWrap = false;
    } else if (!DROPPED.test(ch)) {
      write(ch);
    }
  }

  const grid = screen.map(rowRuns);
  while (grid.length > 0 && grid[grid.length - 1].length === 0) grid.pop();
  return { grid, cursor: { col, row } };
}

/** Lays a block's transcript out in place, for an edit to land the grid in its own write and history entry; the baker then only draws the PNG. A block with no transcript keeps its captured grid. */
export function landTranscriptSnapshot(terminal: SceneDocTerminal, sceneStem: string): void {
  const resolved = resolveSceneTerminal({ terminal });
  if (!resolved?.transcript) return;
  terminal.snapshot = {
    ...layoutTranscript(resolved.transcript, resolved.cols, resolved.rows),
    src: terminalSnapshotSrc(sceneStem),
    transcript: resolved.transcript,
  };
}
