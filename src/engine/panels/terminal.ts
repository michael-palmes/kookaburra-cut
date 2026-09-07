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
  /** Opts out of the F-006 workspace confinement (scene terminals open a user-chosen start path). */
  allowExternalCwd?: boolean;
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
      allowExternalCwd: opts.allowExternalCwd ?? false,
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

/** One scene of the open project, as the app already has it loaded. */
export interface SessionScene {
  /** Manifest module path, e.g. `scenes/02-hero.tsx`: the CLI's edit target. */
  file: string;
  /** Sidecar display name, or null for a scene without one. */
  name: string | null;
}

/** What the app knows about the project a session drives, for the grounding the CLI can't discover: which project is open in the app right now. */
export interface SessionProject {
  /** The workspace folder name (also the session registry key). */
  slug: string;
  /** The project's display name, or null when the app can't resolve one. */
  name: string | null;
  /** The project's scenes in timeline order, as loaded at launch. */
  scenes: readonly SessionScene[];
}

/** Past this many scenes the list is summarised, so a long deck can't crowd out the lines under it. */
const GROUNDING_SCENE_MAX = 20;

/** Project text is user-supplied and lands inside an app-owned system prompt AND the terminal: strip controls, flatten whitespace and cap the length, so a crafted name can't forge grounding lines or move the cursor. */
function projectText(value: string): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80).trimEnd()}…` : flat;
}

/** The project's name for the grounding, falling back to the folder when the app has none. */
function projectLabel(project: SessionProject): string {
  const name = project.name ? projectText(project.name) : "";
  const slug = projectText(project.slug);
  return name ? `"${name}" (folder ${slug})` : `the project in folder ${slug}`;
}

/** The scene roster the CLI would otherwise have to read project.json and every sidecar to learn. */
function sceneList(scenes: readonly SessionScene[]): string {
  const parts = scenes.slice(0, GROUNDING_SCENE_MAX).map((scene) => {
    const name = scene.name ? projectText(scene.name) : "";
    return name ? `${projectText(scene.file)} "${name}"` : projectText(scene.file);
  });
  const rest = scenes.length - parts.length;
  if (rest > 0) parts.push(`and ${rest} more`);
  return parts.join(", ");
}

/** The hidden grounding appended to the session's system prompt: which project the app has open, what is in it, that the user is watching it, and the skill to reach for. The durable rules stay in the project's own CLAUDE.md (user-editable, written once), which this points at rather than restates. */
export function claudeGroundingPrompt(project: SessionProject): string {
  const count = project.scenes.length;
  const scenes = count === 1 ? "1 scene" : `${count} scenes`;
  return [
    "You are the editing assistant inside Kookaburra Cut, a deterministic animated-video studio for macOS.",
    `This session drives ONE video project, ${projectLabel(project)}, which is open in the app right now: the working directory is that project's folder, and it currently has ${scenes} under scenes/.`,
    count > 0 ? `Those scenes, in timeline order: ${sceneList(project.scenes)}.` : "",
    "The user is looking at the app while they type, so treat requests as being about what is on screen now.",
    "Use the kookaburra-scene-authoring skill for any scene, sidecar, theme or toolkit work, from the first message, without waiting to be asked.",
    "CLAUDE.md in this folder is the authority on what you may edit and how; follow it instead of assuming.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The short visible line the panel prints before the CLI starts, so the user knows what this assistant is for. */
export function claudeSessionBanner(project: SessionProject): string {
  const name = project.name ? `"${projectText(project.name)}"` : "this project";
  return `Claude Code is your editing assistant for ${name}: it already knows what you have open, so just ask for scene, text, colour, pacing or media changes in plain English.`;
}

/** The command the panel runs for a project session. `claudePath` is the detected binary (detect_claude), exec'd by full path since detection probes the filesystem while a login non-interactive shell resolves via zprofile PATH only, and the two disagree on a default install (~/.zshrc owns the PATH line), which is exactly the packaged-app case; `continueLast` resumes the folder's most recent conversation (only valid when `hasClaudeSession` is true); the grounding rides `--append-system-prompt`, which applies to resumed sessions too. */
export function claudeSessionCommand(
  continueLast: boolean,
  claudePath: string,
  project: SessionProject,
): string {
  const grounding = shellQuote(claudeGroundingPrompt(project));
  return `exec ${shellQuote(claudePath)}${continueLast ? " --continue" : ""} --permission-mode auto --model claude-opus-5 --effort high --append-system-prompt ${grounding}`;
}

/** The official installer, run VISIBLY inside the terminal for transparency. */
export const CLAUDE_INSTALL_COMMAND = "curl -fsSL https://claude.ai/install.sh | bash";

/** Native/npm installs update in place, by full path (same PATH rationale as sessions). */
export function claudeUpdateCommand(claudePath: string): string {
  return `${shellQuote(claudePath)} update`;
}

/** Brew never auto-updates and lags the release channel: drop the cask(s), then the official installer. */
export const CLAUDE_BREW_SWITCH_COMMAND =
  "brew uninstall --cask claude-code claude-code@latest 2>/dev/null; curl -fsSL https://claude.ai/install.sh | bash";

/** Read-only install diagnostics, run visibly. */
export function claudeDoctorCommand(claudePath: string): string {
  return `${shellQuote(claudePath)} doctor`;
}

/** The native probe's result: local `--version` + the daily-cached latest (see claude_update.rs). */
export interface ClaudeVersionInfo {
  path: string;
  method: "native" | "brew" | "npm" | "other";
  installed: string | null;
  latest: string | null;
  outdated: boolean;
  dismissed: boolean;
}

/** Null when Claude Code isn't installed; latest is cached daily and silent offline. */
export function claudeVersionInfo(): Promise<ClaudeVersionInfo | null> {
  return invoke<ClaudeVersionInfo | null>("claude_version_info");
}

/** "Later" on the update banner: never re-offer this version. */
export function dismissClaudeUpdate(version: string): Promise<void> {
  return invoke<void>("dismiss_claude_update", { version });
}

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
