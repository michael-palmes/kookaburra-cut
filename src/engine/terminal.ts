import { Channel, invoke } from "@tauri-apps/api/core";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** PTY session wiring for the embedded terminal: pairs an xterm.js instance with a native PTY (src-tauri/src/pty.rs), with output arriving over an ipc Channel as raw byte chunks and keystrokes flowing back via pty_write; the xterm.js watermark flow-control scheme pauses the native reader when the renderer falls behind (xterm parses ~5-35 MB/s and drops data past a 50 MB input buffer, so `cat` on a big file would otherwise wedge the panel). */

/** Pause draining above this many un-rendered bytes… */
const HIGH_WATERMARK = 128 * 1024;
/** …and resume once xterm has chewed back down below this. */
const LOW_WATERMARK = 16 * 1024;

export interface TerminalSession {
  readonly id: number;
  /** Paste text into the session via xterm (bracketed-paste aware, so multi-line prompt templates arrive as one block, not line-by-line submissions). */
  paste(text: string): void;
  /** Propagate a fit() result to the PTY (SIGWINCH to the child). */
  resize(cols: number, rows: number): void;
  /** Kill the child; the exit callback fires once it's reaped. */
  dispose(): void;
}

export async function spawnTerminalSession(opts: {
  term: Terminal;
  cwd: string;
  /** Optional command run via `shell -l -c …`; absent → interactive login shell. */
  command?: string;
  /** Directory prepended to the child's PATH (survives /etc/zprofile's path_helper); packaged apps inherit launchd's bare PATH, and the default Claude install adds its dir in ~/.zshrc, which a login non-interactive shell never sources. */
  pathPrepend?: string;
  onExit?: (code: number) => void;
}): Promise<TerminalSession> {
  const { term } = opts;
  let disposed = false;
  let pending = 0;
  let paused = false;
  let id = -1;

  const maybePause = () => {
    if (!paused && pending > HIGH_WATERMARK) {
      paused = true;
      invoke("pty_pause", { id }).catch(() => {});
    }
  };
  const maybeResume = () => {
    if (paused && pending < LOW_WATERMARK) {
      paused = false;
      invoke("pty_resume", { id }).catch(() => {});
    }
  };

  const channel = new Channel<ArrayBuffer | { exit: number }>();
  channel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) {
      if (disposed) return; // no more output after an explicit kill
      const bytes = new Uint8Array(message);
      pending += bytes.byteLength;
      maybePause();
      term.write(bytes, () => {
        pending -= bytes.byteLength;
        maybeResume();
      });
      return;
    }
    // The exit notification must fire even after dispose(), since the registry/UI cleanup rides on it (an early `disposed` gate here once left dead sessions stuck as "running"); the reader thread sends it exactly once.
    if (message && typeof message === "object" && "exit" in message) {
      opts.onExit?.(message.exit);
    }
  };

  id = await invoke<number>("pty_spawn", {
    options: {
      cwd: opts.cwd,
      command: opts.command ?? null,
      pathPrepend: opts.pathPrepend ?? null,
      cols: term.cols,
      rows: term.rows,
    },
    onData: channel,
  });

  // Keystrokes (and xterm-mediated pastes) → PTY stdin.
  const dataSub = term.onData((data) => {
    void invoke("pty_write", { id, data }).catch(() => {});
  });

  return {
    id,
    paste(text: string) {
      // xterm wraps this in bracketed-paste markers when the app (claude) has enabled the mode, then routes it through onData above.
      term.paste(text);
    },
    resize(cols: number, rows: number) {
      void invoke("pty_resize", { id, cols, rows }).catch(() => {});
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dataSub.dispose();
      void invoke("pty_kill", { id }).catch(() => {});
    },
  };
}

/** Where the Claude Code CLI lives, or null when not installed (login-shell resolution). */
export function detectClaude(): Promise<string | null> {
  return invoke<string | null>("detect_claude");
}

/** Whether Claude Code has stored conversations for this folder (`--continue` errors without one; see pty.rs `has_claude_session`). */
export function hasClaudeSession(cwd: string): Promise<boolean> {
  return invoke<boolean>("has_claude_session", { cwd });
}

/** Single-quote a string for zsh: safe against spaces and every metacharacter; embedded single quotes become the standard `'\''` splice. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The directory holding a detected binary, or null for a bare/relative name. */
export function binaryDir(path: string): string | null {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : null;
}

/** The command the panel runs for a project session. `claudePath` is the detected binary (detect_claude), exec'd by full path since detection probes the filesystem while a login non-interactive shell resolves via zprofile PATH only, and the two disagree on a default install (~/.zshrc owns the PATH line), which is exactly the packaged-app case; `continueLast` resumes the folder's most recent conversation (only valid when `hasClaudeSession` is true). */
export function claudeSessionCommand(continueLast: boolean, claudePath: string): string {
  return `exec ${shellQuote(claudePath)}${continueLast ? " --continue" : ""} --permission-mode acceptEdits`;
}

/** The official installer, run VISIBLY inside the terminal for transparency. */
export const CLAUDE_INSTALL_COMMAND = "curl -fsSL https://claude.ai/install.sh | bash";

// ── Live session registry ────────────────────────────────────────
// Sessions outlive the panel component: switching projects detaches the terminal's DOM but keeps the PTY (and any mid-flight Claude work) alive, and switching back re-attaches with full scrollback. Entries end when the child exits, on explicit end, or with the app (the PTY master dies with this process, so the child gets SIGHUP).

export type LiveStatus = "running" | "installing";

export interface LiveTerminal {
  term: Terminal;
  fit: FitAddon;
  session: TerminalSession;
  status: LiveStatus;
  /** Set by the currently-mounted panel so a detached session's exit still updates UI. */
  notify?: (next: "idle" | "exited") => void;
}

const liveSessions = new Map<string, LiveTerminal>();

export function getLiveSession(slug: string): LiveTerminal | undefined {
  return liveSessions.get(slug);
}

export function setLiveSession(slug: string, entry: LiveTerminal): void {
  liveSessions.set(slug, entry);
}

export function removeLiveSession(slug: string): void {
  liveSessions.delete(slug);
}
