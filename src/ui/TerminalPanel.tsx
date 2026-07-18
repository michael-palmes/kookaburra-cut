import { invoke } from "@tauri-apps/api/core";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  binaryDir,
  CLAUDE_INSTALL_COMMAND,
  claudeSessionCommand,
  detectClaude,
  getLiveSession,
  hasClaudeSession,
  removeLiveSession,
  setLiveSession,
  spawnTerminalSession,
} from "../engine/terminal";
import { useUiStore } from "../store/uiStore";
import type { Theme } from "../theme/tokens";
import { HelperWizard, type WizardKind } from "./HelperWizards";
import { EditSceneWizard, NewSceneWizard, type WizardSceneInfo } from "./SceneWizards";

/** Embedded Claude Code panel: xterm.js with the DOM renderer (the WebGL addon is broken in current WebKit) bound to a native PTY; sessions live in the module-level registry (engine/terminal.ts) and outlive this component, so switching projects keeps them running; helper chips paste prompts via bracketed paste without submitting, so the user reviews before pressing Enter. */

type PanelStatus = "idle" | "detecting" | "missing" | "installing" | "running" | "exited";

/** A session that dies this fast never worked; surface the shell's parting words since the overlay covers the scrollback and they'd otherwise vanish with the flash. */
const QUICK_EXIT_MS = 5000;

/** The terminal's last non-empty lines, oldest first. */
function lastTerminalLines(term: Terminal, max = 3): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = buf.length - 1; i >= 0 && lines.length < max; i--) {
    const text = buf.getLine(i)?.translateToString(true).trim();
    if (text) lines.unshift(text);
  }
  return lines.join("\n");
}

/** The ⋯ assist menu: prompt-paste helpers that DO need a session. */
const MORE_MENU: { label: string; kind: WizardKind }[] = [
  { label: "Change pacing", kind: "pacing" },
  { label: "Change the look", kind: "look" },
  { label: "Use my media", kind: "media" },
];

/** Build the xterm theme from the live design tokens so the panel matches the chrome. */
function themeFromTokens(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--surface-recessed", "#090b10"),
    foreground: token("--text-primary", "#f0efeb"),
    cursor: token("--accent", "#6f93a8"),
    cursorAccent: token("--surface-recessed", "#090b10"),
    selectionBackground: token("--selection", "rgba(76,159,239,0.30)"),
  };
}

export function TerminalPanel({
  slug,
  cwd,
  scenes,
  theme,
  exporting,
  getThumbs,
  onProjectChanged,
}: {
  /** Workspace project slug (provisioning + the session registry key). */
  slug: string;
  /** Absolute project path the shell starts in. */
  cwd: string;
  /** The loaded project's scenes, for the wizards (pickers + scene-aware dropdowns). */
  scenes: WizardSceneInfo[];
  /** The project's theme, for the New-scene wizard's colour swatch defaults. */
  theme: Theme;
  /** An export/verify is running; warn against concurrent edits. */
  exporting: boolean;
  /** Lazily capture/fetch scene-picker thumbnails. */
  getThumbs: () => Promise<Record<string, string>>;
  /** A native write changed project.json/scenes; reload the preview immediately. */
  onProjectChanged: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [ready, setReady] = useState(false);
  const [hasPrior, setHasPrior] = useState(false);
  const [wizard, setWizard] = useState<WizardKind | "new-scene-native" | "edit-scene" | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** Why the last session ended immediately (shell error text), or null. */
  const [exitNote, setExitNote] = useState<string | null>(null);

  // Stable notifier the registry can call when a (possibly detached) session exits.
  const notifyRef = useRef((next: "idle" | "exited") => setStatus(next));

  // Mount: adopt the project's live session if one exists (re-attach DOM, keep the process), else create a fresh idle terminal; unmount: detach a live session's DOM without killing it, dispose only when nothing is running.
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      // Glyph metrics are measured at open(); a not-yet-loaded font garbles the grid.
      await document.fonts.ready;
      if (disposed || !containerRef.current) return;

      const live = getLiveSession(slug);
      let term: Terminal;
      let fit: FitAddon;
      if (live?.term.element) {
        term = live.term;
        fit = live.fit;
        containerRef.current.appendChild(live.term.element);
        live.notify = notifyRef.current;
        setStatus(live.status);
      } else {
        term = new Terminal({
          cursorBlink: true,
          fontSize: 12,
          fontFamily: 'Menlo, ui-monospace, "SF Mono", monospace',
          scrollback: 8000,
          allowProposedApi: true, // unicode11 addon
          theme: themeFromTokens(),
        });
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = "11";
        fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new ClipboardAddon());
        term.open(containerRef.current);
      }
      termRef.current = term;
      fitRef.current = fit;
      fit.fit();
      getLiveSession(slug)?.session.resize(term.cols, term.rows);
      observer = new ResizeObserver(() => {
        fit.fit();
        getLiveSession(slug)?.session.resize(term.cols, term.rows);
      });
      observer.observe(containerRef.current);
      setReady(true);
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      const live = getLiveSession(slug);
      if (live && live.term === termRef.current) {
        // Keep the session (and its terminal buffer) alive; just take the DOM back out.
        live.notify = undefined;
        live.term.element?.remove();
      } else {
        termRef.current?.dispose();
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [slug]);

  // Offer "Continue last conversation" only when this folder actually has one, since `claude --continue` errors out otherwise; re-probed whenever we return to a startable state.
  useEffect(() => {
    if (status !== "idle" && status !== "exited") return;
    let cancelled = false;
    hasClaudeSession(cwd)
      .then((v) => {
        if (!cancelled) setHasPrior(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status, cwd]);

  const startSession = useCallback(
    async (continueLast: boolean) => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit || getLiveSession(slug)) return;
      setStatus("detecting");
      setExitNote(null);
      try {
        const path = await detectClaude();
        if (!path) {
          setStatus("missing");
          return;
        }
        // Heal provisioning (managed skill copy, missing CLAUDE.md/settings) before launch.
        await invoke("provision_project", { slug }).catch(() => {});
        term.clear();
        const startedAt = Date.now();
        const session = await spawnTerminalSession({
          term,
          cwd,
          // Exec the detected binary and put its dir on the child PATH: a login non-interactive shell never sources ~/.zshrc (where the default install writes its PATH line), and packaged apps have no interactive PATH to inherit.
          command: claudeSessionCommand(continueLast, path),
          pathPrepend: binaryDir(path) ?? undefined,
          onExit: () => {
            const entry = getLiveSession(slug);
            if (entry?.session === session) {
              removeLiveSession(slug);
              if (Date.now() - startedAt < QUICK_EXIT_MS) {
                // xterm writes are async and the exit message can outrun the shell's final output; a zero-write barrier parses everything queued first.
                term.write("", () => setExitNote(lastTerminalLines(term)));
              }
              entry.notify?.("exited");
            }
          },
        });
        setLiveSession(slug, {
          term,
          fit,
          session,
          status: "running",
          notify: notifyRef.current,
        });
        session.resize(term.cols, term.rows);
        setStatus("running");
        term.focus();
      } catch (e) {
        termRef.current?.writeln(`\r\n${String(e)}`);
        setExitNote(String(e));
        setStatus("exited");
      }
    },
    [slug, cwd],
  );

  // Install flow: an interactive login shell with the official installer typed into it, so the user watches exactly what a curl|bash runs; when it finishes they click through to start Claude, which re-detects.
  const startInstall = useCallback(async () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || getLiveSession(slug)) return;
    setStatus("installing");
    setExitNote(null);
    term.clear();
    try {
      const session = await spawnTerminalSession({
        term,
        cwd,
        onExit: () => {
          const entry = getLiveSession(slug);
          if (entry?.session === session) {
            removeLiveSession(slug);
            entry.notify?.("idle");
          }
        },
      });
      setLiveSession(slug, {
        term,
        fit,
        session,
        status: "installing",
        notify: notifyRef.current,
      });
      session.resize(term.cols, term.rows);
      await invoke("pty_write", { id: session.id, data: `${CLAUDE_INSTALL_COMMAND}\n` });
      term.focus();
    } catch (e) {
      termRef.current?.writeln(`\r\n${String(e)}`);
      setStatus("exited");
    }
  }, [slug, cwd]);

  /** Kill whatever is running and start a fresh Claude conversation; used by the "New session" chip and the install-flow handoff. */
  const startNewSession = useCallback(() => {
    const entry = getLiveSession(slug);
    if (entry) {
      // Supersede: detach from the registry first so the old child's exit can't stomp the new session's state, then kill it.
      entry.notify = undefined;
      removeLiveSession(slug);
      entry.session.dispose();
    }
    void startSession(false);
  }, [slug, startSession]);

  const pasteChip = useCallback(
    (text: string) => {
      getLiveSession(slug)?.session.paste(text);
      termRef.current?.focus();
    },
    [slug],
  );

  /** Open a scene wizard, kicking off the lazy thumb capture (cards fill in as it lands). */
  const openSceneWizard = useCallback(
    (which: "new-scene-native" | "edit-scene") => {
      setMoreOpen(false);
      setWizard(which);
      getThumbs()
        .then(setThumbs)
        .catch(() => {});
    },
    [getThumbs],
  );

  // The playback bar / ⌘K channel: a pending wizard request opens the matching wizard once the rail is mounted, then clears itself.
  const railWizardRequest = useUiStore((s) => s.railWizardRequest);
  useEffect(() => {
    if (!railWizardRequest) return;
    openSceneWizard(railWizardRequest === "new-scene" ? "new-scene-native" : "edit-scene");
    useUiStore.getState().requestRailWizard(null);
  }, [railWizardRequest, openSceneWizard]);

  return (
    <div className="terminal-panel">
      {exporting && (
        <div className="rail-banner" role="status">
          Export in progress — hold off on edits until it finishes.
        </div>
      )}

      <div className="rail-actions">
        {/* Scaffold/edit are native, available with no Claude session. */}
        <button
          type="button"
          className="btn primary btn-small"
          title="Create a scene with the pickers — no typing needed"
          onClick={() => openSceneWizard("new-scene-native")}
        >
          ＋ New scene
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Edit a scene's text, device, media, motion or shadow"
          disabled={scenes.length === 0}
          onClick={() => openSceneWizard("edit-scene")}
        >
          ✎ Edit scene
        </button>
        <div className="rail-more">
          <button
            type="button"
            className="btn btn-small"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title="More assists (paste a prompt for Claude)"
            onClick={() => setMoreOpen((v) => !v)}
          >
            ⋯
          </button>
          {moreOpen && (
            <div className="rail-menu" role="menu">
              {MORE_MENU.map((item) => (
                <button
                  type="button"
                  key={item.kind}
                  role="menuitem"
                  className="rail-menu-item"
                  disabled={status !== "running"}
                  title={
                    status === "running"
                      ? "Opens a small form, then pastes the prompt — edit it, then press Enter"
                      : "Start Claude Code first"
                  }
                  onClick={() => {
                    setMoreOpen(false);
                    setWizard(item.kind);
                  }}
                >
                  {item.label}
                </button>
              ))}
              {/* New session lives in the overflow now (the quick-action row is New scene · Edit scene · ⋯). */}
              <button
                type="button"
                role="menuitem"
                className="rail-menu-item"
                disabled={status !== "running"}
                title="End this conversation and start a fresh one"
                onClick={() => {
                  setMoreOpen(false);
                  startNewSession();
                }}
              >
                ↺ New session
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="terminal-host">
        <div ref={containerRef} className="terminal-screen" />

        {status !== "running" && status !== "installing" && (
          <div className="terminal-overlay">
            {status === "missing" ? (
              <>
                <h3>Claude Code isn’t installed</h3>
                <p className="muted">
                  Kookaburra Cut uses the Claude Code command-line tool as your editing assistant.
                  The official installer runs right here in the terminal, so you can see exactly
                  what it does.
                </p>
                <button type="button" className="btn primary" onClick={() => void startInstall()}>
                  Install Claude Code
                </button>
              </>
            ) : (
              <>
                <h3>Edit with Claude Code</h3>
                <p className="muted">
                  Starts a Claude session in this project’s folder. Scene edits apply automatically;
                  anything else still asks first.
                </p>
                {status === "exited" && exitNote && (
                  <p className="terminal-exit-note" role="alert">
                    The session ended right away — last output:{"\n"}
                    {exitNote}
                  </p>
                )}
                <div className="overlay-actions">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!ready || status === "detecting"}
                    onClick={() => void startSession(hasPrior)}
                  >
                    {status === "detecting"
                      ? "Checking…"
                      : hasPrior
                        ? "Continue last conversation"
                        : status === "exited"
                          ? "Restart session"
                          : "Start Claude Code"}
                  </button>
                  {hasPrior && (
                    <button
                      type="button"
                      className="btn"
                      disabled={!ready || status === "detecting"}
                      onClick={() => void startSession(false)}
                    >
                      Start fresh
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {status === "installing" && (
        <div className="rail-footer">
          <span className="muted">When the installer finishes:</span>
          <button type="button" className="btn" onClick={startNewSession}>
            Start Claude Code
          </button>
        </div>
      )}

      {wizard === "new-scene-native" && (
        <NewSceneWizard
          slug={slug}
          projectPath={cwd}
          scenes={scenes}
          thumbs={thumbs}
          theme={theme}
          sessionRunning={status === "running"}
          onDone={(_result, prompt) => {
            setWizard(null);
            onProjectChanged();
            if (prompt) pasteChip(prompt);
          }}
          onCancel={() => setWizard(null)}
        />
      )}
      {wizard === "edit-scene" && (
        <EditSceneWizard
          slug={slug}
          projectPath={cwd}
          scenes={scenes}
          thumbs={thumbs}
          onSaved={() => {
            setWizard(null);
            onProjectChanged();
          }}
          onCancel={() => setWizard(null)}
        />
      )}
      {wizard && wizard !== "new-scene-native" && wizard !== "edit-scene" && (
        <HelperWizard
          kind={wizard}
          scenes={scenes}
          slug={slug}
          onInsert={(prompt) => {
            setWizard(null);
            pasteChip(prompt);
          }}
          onCancel={() => setWizard(null)}
        />
      )}
    </div>
  );
}
