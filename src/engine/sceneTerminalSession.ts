/** Scene-terminal session registry: one live PTY per scene block, keyed `${slug}#${sceneStem}` and outliving the overlay component exactly as the rail's sessions outlive its panel (detach keeps the process and scrollback, re-attach restores them). Scene terminals differ from the rail in three ways: the grid is the LOGICAL size from the sidecar (no fit addon, the overlay scales visually), the theme is the block's resolved colour preset (full ANSI 16), and the start command is pre-typed but never run (docs/decisions.md). */

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { type ITheme, Terminal } from "@xterm/xterm";
import { type ResolvedSceneTerminal, sanitizeStartCommand } from "./sceneTerminal";
import { TERMINAL_FONT_STACK } from "./sceneTerminalRaster";
import type { SceneTerminalColours } from "./sceneTerminalTheme";
import { spawnTerminalSession, type TerminalSession } from "./terminal";

export type SceneTerminalStatus = "running" | "exited";

export interface SceneTerminalLive {
  term: Terminal;
  session: TerminalSession;
  status: SceneTerminalStatus;
  /** Set by the currently-mounted overlay so a detached session's exit still updates UI. */
  notify?: (status: SceneTerminalStatus) => void;
}

const live = new Map<string, SceneTerminalLive>();

// A tiny external store over the registry, so a mounted overlay adopts a session the inspector drill starts (the sceneHostRegistry subscribe idiom).
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeSceneTerminalSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sceneTerminalSessionsVersion(): number {
  return version;
}

export function sceneTerminalKey(slug: string, sceneStem: string): string {
  return `${slug}#${sceneStem}`;
}

export function getSceneTerminalSession(key: string): SceneTerminalLive | undefined {
  return live.get(key);
}

/** The block's colour preset as an xterm theme; the opaque screen colour sits seamlessly over the panel's own screen plane. */
export function sceneTerminalITheme(colours: SceneTerminalColours): ITheme {
  const [black, red, green, yellow, blue, magenta, cyan, white] = colours.ansi;
  const [
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = colours.ansi.slice(8);
  return {
    background: colours.screen,
    foreground: colours.foreground,
    cursor: colours.cursor,
    cursorAccent: colours.screen,
    selectionBackground: `${colours.cursor}55`,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

/** Retheme and resize a live session to the block's current settings (the sidecar may change under a running shell). */
export function applySceneTerminalSettings(
  entry: SceneTerminalLive,
  terminal: ResolvedSceneTerminal,
  colours: SceneTerminalColours,
): void {
  entry.term.options.theme = sceneTerminalITheme(colours);
  entry.term.options.fontSize = terminal.fontPx;
  if (entry.term.cols !== terminal.cols || entry.term.rows !== terminal.rows) {
    entry.term.resize(terminal.cols, terminal.rows);
    entry.session.resize(terminal.cols, terminal.rows);
  }
}

/** Spawn a fresh session for a scene block: an interactive login shell at the block's start path, the start command pre-typed into the prompt (the presenter presses Enter). Any previous entry for the key is killed first (the restart path). */
export async function startSceneTerminalSession(opts: {
  key: string;
  cwd: string;
  terminal: ResolvedSceneTerminal;
  colours: SceneTerminalColours;
}): Promise<SceneTerminalLive> {
  const previous = live.get(opts.key);
  if (previous) {
    // Detach from the registry before killing so the dying child's exit can't stomp the new session's state (the rail's new-session rule).
    live.delete(opts.key);
    previous.notify = undefined;
    previous.session.dispose();
    previous.term.dispose();
  }
  const { terminal, colours } = opts;
  const term = new Terminal({
    cursorBlink: true,
    cols: terminal.cols,
    rows: terminal.rows,
    fontSize: terminal.fontPx,
    fontFamily: TERMINAL_FONT_STACK,
    scrollback: 2000,
    allowProposedApi: true, // unicode11 addon
    theme: sceneTerminalITheme(colours),
  });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new ClipboardAddon());

  const entry: SceneTerminalLive = {
    term,
    session: null as unknown as TerminalSession,
    status: "running",
  };
  entry.session = await spawnTerminalSession({
    term,
    cwd: opts.cwd,
    // The F-006 opt-out only when the block actually leaves the workspace (docs/decisions.md).
    allowExternalCwd: terminal.startPath != null,
    onExit: () => {
      entry.status = "exited";
      entry.notify?.("exited");
    },
  });
  live.set(opts.key, entry);
  if (terminal.startCommand) {
    // Pre-typed, never submitted: a single sanitised line, so a newline can't reach the shell as Enter before bracketed-paste mode is up (docs/decisions.md).
    const command = sanitizeStartCommand(terminal.startCommand);
    if (command) entry.session.paste(command);
  }
  bump();
  return entry;
}

/** Kill and forget a scene session (restart, or a deliberate stop). */
export function killSceneTerminalSession(key: string): void {
  const entry = live.get(key);
  if (!entry) return;
  live.delete(key);
  entry.notify = undefined;
  entry.session.dispose();
  entry.term.dispose();
  bump();
}
