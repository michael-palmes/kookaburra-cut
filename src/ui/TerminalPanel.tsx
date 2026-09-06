import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseProjectId } from "../engine/project";
import {
  binaryDir,
  CLAUDE_BREW_SWITCH_COMMAND,
  CLAUDE_INSTALL_COMMAND,
  type ClaudeVersionInfo,
  claudeDoctorCommand,
  claudeSessionBanner,
  claudeSessionCommand,
  claudeUpdateCommand,
  claudeVersionInfo,
  detectClaude,
  dismissClaudeUpdate,
  getLiveSession,
  hasClaudeSession,
  removeLiveSession,
  type SessionProject,
  setLiveSession,
  spawnTerminalSession,
} from "../engine/terminal";
import { useUiStore } from "../store/uiStore";
import { HelperWizard, type WizardKind } from "./HelperWizards";
import { railIcon } from "./libraryIcons";
import { PresetGalleryModal } from "./PresetGalleryModal";
import { EditSceneWizard, sceneIndexAtPlayhead, type WizardSceneInfo } from "./SceneWizards";

/** Embedded Claude Code panel: xterm.js with the DOM renderer (the WebGL addon is broken in current WebKit) bound to a native PTY; sessions live in the module-level registry (engine/terminal.ts) and outlive this component, so switching projects keeps them running; helper chips paste prompts via bracketed paste without submitting, so the user reviews before pressing Enter. */

type PanelStatus = "idle" | "detecting" | "missing" | "installing" | "running" | "exited";

/** A session that dies this fast never worked; surface the shell's parting words since the overlay covers the scrollback and they'd otherwise vanish with the flash. */
const QUICK_EXIT_MS = 5000;

/** The terminal's last non-empty lines, oldest first, ignoring everything above `floor` (the rows the panel itself printed before launching, which are not diagnostics). */
function lastTerminalLines(term: Terminal, floor = 0, max = 3): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = buf.length - 1; i >= floor && lines.length < max; i--) {
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
  projectName,
  scenes,
  readThumbs,
  captureThumbs,
  onProjectChanged,
}: {
  /** Workspace project slug (provisioning + the session registry key). */
  slug: string;
  /** Absolute project path the shell starts in. */
  cwd: string;
  /** The open project's display name, for the session banner and grounding; null when unresolved. */
  projectName?: string | null;
  /** The loaded project's scenes, for the wizards (pickers + scene-aware dropdowns). */
  scenes: WizardSceneInfo[];
  /** Scene-picker thumbnails straight from the cache: no capture, no clock borrow. */
  readThumbs: () => Promise<Record<string, string>>;
  /** Capture the scene-picker thumbnails that are missing or stale (borrows the preview clock). */
  captureThumbs: (signal?: AbortSignal) => Promise<Record<string, string>>;
  /** A native write changed project.json/scenes; reload the preview immediately. `focusSceneFile` lands the playhead on that scene after the reload. */
  onProjectChanged: (focusSceneFile?: string) => void;
}) {
  const scope = parseProjectId(slug).scope;
  const canAddScenes = scope !== "preset" && scope !== "ws-preset";
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [ready, setReady] = useState(false);
  const [hasPrior, setHasPrior] = useState(false);
  const [wizard, setWizard] = useState<WizardKind | "new-scene" | "edit-scene" | null>(null);
  const [newScenePosition, setNewScenePosition] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** Why the last session ended immediately (shell error text), or null. */
  const [exitNote, setExitNote] = useState<string | null>(null);
  /** The version probe: null = not installed or not probed yet. */
  const [versionInfo, setVersionInfo] = useState<ClaudeVersionInfo | null>(null);

  // Stable notifier the registry can call when a (possibly detached) session exits.
  const notifyRef = useRef((next: "idle" | "exited") => setStatus(next));
  // The grounding wants the scene roster as it stands at launch; via a ref so a rebuilt scenes array can't churn startSession's identity.
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;

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

  // Version probe on startable states (so an install/update run refreshes it on exit); the native side caches the latest-version fetch for a day and stays silent offline.
  useEffect(() => {
    if (status !== "idle" && status !== "exited" && status !== "running") return;
    let cancelled = false;
    claudeVersionInfo()
      .then((v) => {
        if (!cancelled) setVersionInfo(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status]);

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
        // Heal provisioning (managed skill copy, missing CLAUDE.md/settings) before launch. `false` = the packaged skill resource is missing (a packaging defect): warn visibly where the user is about to type, rather than starting Claude silently unskilled; an invoke throw stays soft (the session is still useful).
        const provisioned = await invoke<boolean>("provision_project", { slug }).catch(() => true);
        term.clear();
        if (provisioned === false) {
          term.writeln(
            "\r\n⚠ Kookaburra Cut's scene-authoring skill is missing from this install, so Claude may not know this app's conventions. Try reinstalling Kookaburra Cut.\r\n",
          );
        }
        const project: SessionProject = {
          slug,
          name: projectName ?? null,
          scenes: scenesRef.current.map((s) => ({ file: s.file, name: s.name })),
        };
        term.writeln(`\r\n${claudeSessionBanner(project)}\r\n`);
        // Writes are queued, so this lands after the banner and before any PTY output: the row the shell's own output starts on.
        let noteFloor = 0;
        term.write("", () => {
          noteFloor = term.buffer.active.baseY + term.buffer.active.cursorY;
        });
        const startedAt = Date.now();
        const session = await spawnTerminalSession({
          term,
          cwd,
          // Exec the detected binary and put its dir on the child PATH: a login non-interactive shell never sources ~/.zshrc (where the default install writes its PATH line), and packaged apps have no interactive PATH to inherit.
          command: claudeSessionCommand(continueLast, path, project),
          pathPrepend: binaryDir(path) ?? undefined,
          onExit: () => {
            const entry = getLiveSession(slug);
            if (entry?.session === session) {
              removeLiveSession(slug);
              if (Date.now() - startedAt < QUICK_EXIT_MS) {
                // xterm writes are async and the exit message can outrun the shell's final output; a zero-write barrier parses everything queued first.
                term.write("", () => setExitNote(lastTerminalLines(term, noteFloor)));
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
    [slug, cwd, projectName],
  );

  // Install/update/diagnostics flow: an interactive login shell with the command typed into it, so the user watches exactly what runs; when it finishes they click through to start Claude, which re-detects.
  const runVisibleCommand = useCallback(
    async (command: string) => {
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
        await invoke("pty_write", { id: session.id, data: `${command}\n` });
        term.focus();
      } catch (e) {
        termRef.current?.writeln(`\r\n${String(e)}`);
        setStatus("exited");
      }
    },
    [slug, cwd],
  );

  const startInstall = useCallback(
    () => runVisibleCommand(CLAUDE_INSTALL_COMMAND),
    [runVisibleCommand],
  );

  // The banner's one click: brew installs switch to the official installer (brew's cask never auto-updates and trails the release channel); everything else updates in place.
  const startUpdate = useCallback(() => {
    const info = versionInfo;
    if (!info) return;
    return runVisibleCommand(
      info.method === "brew" ? CLAUDE_BREW_SWITCH_COMMAND : claudeUpdateCommand(info.path),
    );
  }, [runVisibleCommand, versionInfo]);

  const dismissUpdateBanner = useCallback(() => {
    const latest = versionInfo?.latest;
    if (!latest) return;
    setVersionInfo((v) => (v ? { ...v, dismissed: true } : v));
    void dismissClaudeUpdate(latest).catch(() => {});
  }, [versionInfo]);

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

  /** Cards fill in progressively, so a later listing only ever adds to what is already showing. */
  const addThumbs = useCallback((next: Record<string, string>) => {
    setThumbs((prev) => ({ ...prev, ...next }));
  }, []);

  // Stable request handle: wizards fire it when their thumb grid mounts, so a re-identified `captureThumbs` prop can't re-trigger their step effects.
  const captureRef = useRef(captureThumbs);
  useEffect(() => {
    captureRef.current = captureThumbs;
  });
  const thumbsAbort = useRef<AbortController | null>(null);
  const needThumbs = useCallback(() => {
    thumbsAbort.current?.abort();
    const controller = new AbortController();
    thumbsAbort.current = controller;
    captureRef
      .current(controller.signal)
      .then(addThumbs)
      .catch(() => {});
  }, [addThumbs]);

  /** Open a wizard, painting cached thumbs immediately AND submitting the stale ones straight away: the render window captures in the background (never the editor's clock, which the old pipeline scrubbed), so by the placement step the fresh thumbs are usually already in. */
  const openSceneWizard = useCallback(
    (which: WizardKind | "new-scene" | "edit-scene") => {
      if (!canAddScenes && which === "new-scene") return;
      if (which === "new-scene") {
        setNewScenePosition(sceneIndexAtPlayhead(scenesRef.current) + 1);
      }
      setMoreOpen(false);
      setWizard(which);
      if (which !== "new-scene" && which !== "edit-scene") return;
      readThumbs()
        .then(addThumbs)
        .catch(() => {});
      if (which === "edit-scene") needThumbs();
    },
    [readThumbs, addThumbs, needThumbs, canAddScenes],
  );
  // A closed wizard's queued thumbs are cancelled rather than left draining for nobody.
  useEffect(() => {
    if (wizard === null) thumbsAbort.current?.abort();
    const holder = thumbsAbort;
    return () => holder.current?.abort();
  }, [wizard]);
  // Fresh thumbs land asynchronously from the render window; repaint open grids as they arrive.
  const readRef = useRef(readThumbs);
  useEffect(() => {
    readRef.current = readThumbs;
  });
  useEffect(() => {
    const stop = listen("kookaburra://thumbs-updated", () => {
      readRef
        .current()
        .then(addThumbs)
        .catch(() => {});
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, [addThumbs]);

  // The playback bar opens its requested picker once the rail has mounted.
  const railWizardRequest = useUiStore((s) => s.railWizardRequest);
  useEffect(() => {
    if (!railWizardRequest) return;
    openSceneWizard(railWizardRequest);
    useUiStore.getState().requestRailWizard(null);
  }, [railWizardRequest, openSceneWizard]);

  return (
    <div className="terminal-panel">
      <div className="rail-actions">
        {/* Scene insertion and editing work without a Claude session. */}
        {canAddScenes && (
          <button
            type="button"
            className="btn primary btn-small"
            title="Choose a preset to add as a scene"
            onClick={() => openSceneWizard("new-scene")}
          >
            {railIcon(<path d="M12 5v14M5 12h14" />)}
            Add a scene
          </button>
        )}
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
                  onClick={() => openSceneWizard(item.kind)}
                >
                  {item.label}
                </button>
              ))}
              {/* New session lives in the overflow now (the quick-action row is Add a scene · Edit scene · ⋯). */}
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

      {versionInfo?.outdated && !versionInfo.dismissed && status !== "installing" && (
        <div className="terminal-update-banner">
          <span className="muted">
            {versionInfo.method === "brew"
              ? `Claude Code ${versionInfo.latest} is out (you have ${versionInfo.installed}). Homebrew's build trails behind and never updates itself; the official installer keeps itself current.`
              : `Claude Code ${versionInfo.latest} is available (you have ${versionInfo.installed}).`}
          </span>
          <button
            type="button"
            className="btn btn-small primary"
            title="Runs visibly in the terminal below"
            onClick={() => void startUpdate()}
          >
            {versionInfo.method === "brew" ? "Switch and update" : "Update"}
          </button>
          <button type="button" className="btn btn-small" onClick={dismissUpdateBanner}>
            Later
          </button>
        </div>
      )}

      <div className="terminal-host">
        <div ref={containerRef} className="terminal-screen" />

        {status !== "running" && status !== "installing" && (
          <div className="terminal-overlay">
            {status === "missing" ? (
              <>
                <h3>Claude Code isn’t installed</h3>
                <p className="muted">
                  Kookaburra Cut uses the Claude Code command-line tool as your editing assistant.
                  Install runs Anthropic’s official installer right here in the terminal, so you can
                  see exactly what it does; the first session asks you to log in with your Claude
                  account in the browser, then it keeps itself up to date.
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
                  {status === "exited" && versionInfo && (
                    <button
                      type="button"
                      className="btn"
                      title="Runs claude doctor visibly: read-only install and settings checks"
                      onClick={() => void runVisibleCommand(claudeDoctorCommand(versionInfo.path))}
                    >
                      Run diagnostics
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
          <span className="muted">When it finishes:</span>
          <button type="button" className="btn" onClick={startNewSession}>
            Start Claude Code
          </button>
        </div>
      )}

      {wizard === "new-scene" && canAddScenes && (
        <PresetGalleryModal
          slug={slug}
          position={newScenePosition}
          scenes={scenes}
          thumbs={thumbs}
          onNeedThumbs={needThumbs}
          onDone={(result) => {
            setWizard(null);
            onProjectChanged(result.file);
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
          onNeedThumbs={needThumbs}
          onSaved={() => {
            setWizard(null);
            onProjectChanged();
          }}
          onCancel={() => setWizard(null)}
        />
      )}
      {wizard && wizard !== "new-scene" && wizard !== "edit-scene" && (
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
