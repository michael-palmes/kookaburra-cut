import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type LoadedProject,
  nativeProjectSlug,
  projectFolderPath,
  sceneFileStem,
} from "../engine/project";
import { resolveSceneTerminal, sceneTerminalLayout } from "../engine/sceneTerminal";
import {
  getSceneTerminalSession,
  sceneTerminalKey,
  sceneTerminalSessionsVersion,
  startSceneTerminalSession,
  subscribeSceneTerminalSessions,
} from "../engine/sceneTerminalSession";
import { resolveTerminalColours } from "../engine/sceneTerminalTheme";
import { usePresentStore } from "./presentStore";

/** The slide's live terminal in Present: a fresh session per presentation run (this webview's registry starts empty; revisited slides re-adopt theirs), spawned quietly as the scene enters so the pre-typed command is on the prompt by the hold (project-folder sessions only: a custom start path waits for the first click on the terminal). Click the terminal to type (the click never advances); while focused the deck keys stand down (`terminalFocused`), plain Esc stays with the shell, and Shift+Esc or a click outside hands the keyboard back, that outside click swallowed in the capture phase so it never doubles as an advance. Rust kills this window's PTYs on destroy. */

export function PresentTerminalOverlay({
  project,
  aspect,
}: {
  project: LoadedProject;
  /** Frame aspect (width / height), for the layout's frame-fraction maths. */
  aspect: number;
}) {
  const deck = usePresentStore((s) => s.deck);
  const setTerminalFocused = usePresentStore((s) => s.setTerminalFocused);
  const sceneIndex = deck.sceneIndex;
  const doc = project.sceneDocs[sceneIndex] ?? null;
  const theme = project.sceneThemes[sceneIndex] ?? project.theme;
  const terminal = useMemo(() => resolveSceneTerminal(doc ?? undefined), [doc]);
  const colours = useMemo(
    () => (terminal ? resolveTerminalColours(terminal.theme, theme) : null),
    [terminal, theme],
  );
  const slug = nativeProjectSlug(project.id);
  const stem = sceneFileStem(project.sceneFiles[sceneIndex] ?? "");
  const key = sceneTerminalKey(slug, stem);
  const atRest = deck.phase === "entering" || deck.phase === "holding";

  const sessionsTick = useSyncExternalStore(
    subscribeSceneTerminalSessions,
    sceneTerminalSessionsVersion,
    sceneTerminalSessionsVersion,
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef<HTMLDivElement | null>(null);
  const [attached, setAttached] = useState(false);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  // A click-started session focuses once its DOM attaches (focus needs the opened textarea).
  const focusOnAttachRef = useRef(false);
  // In flight between spawn and registry-set: a click during that window must not start a second PTY.
  const spawnPendingRef = useRef(false);

  // Spawn quietly on scene entry; a failed spawn (a pack's machine-specific start path) leaves the baked snapshot showing, never an error card mid-show. A custom start path never auto-spawns: sidecar data must not open a shell outside the project on its own, so the first click on the terminal starts that session instead (docs/scene-terminal.md).
  useEffect(() => {
    if (!terminal || !colours || !atRest || !stem) return;
    if (terminal.startPath || spawnPendingRef.current || getSceneTerminalSession(key)) return;
    const cwd = projectFolderPath(project.id);
    if (!cwd) return;
    spawnPendingRef.current = true;
    void startSceneTerminalSession({ key, cwd, terminal, colours })
      .catch((e) => {
        console.warn("[present] terminal session start failed:", e);
      })
      .finally(() => {
        spawnPendingRef.current = false;
      });
  }, [key, project.id, stem, terminal, colours, atRest]);

  // Attach the session's DOM (open fresh, re-append on a revisited slide); detach without killing on the way out.
  useEffect(() => {
    void sessionsTick;
    let cancelled = false;
    void (async () => {
      const entry = getSceneTerminalSession(key);
      const host = scaleRef.current;
      if (!entry || !host) {
        setAttached(false);
        return;
      }
      if (!entry.term.element) {
        await document.fonts.ready;
        if (cancelled) return;
        entry.term.open(host);
      } else if (entry.term.element.parentElement !== host) {
        host.appendChild(entry.term.element);
      }
      setAttached(true);
      if (focusOnAttachRef.current) {
        focusOnAttachRef.current = false;
        entry.term.focus();
      }
    })();
    return () => {
      cancelled = true;
      getSceneTerminalSession(key)?.term.element?.remove();
      setAttached(false);
      setFocused(false);
      focusedRef.current = false;
      setTerminalFocused(false);
    };
  }, [key, sessionsTick, setTerminalFocused]);

  // Fit the xterm's natural pixel size onto the grid rect: uniform scale, top-left anchored.
  useEffect(() => {
    const host = hostRef.current;
    const inner = scaleRef.current;
    if (!host || !inner || !attached) return;
    const solve = () => {
      const screen = inner.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || screen.offsetWidth === 0) return;
      const scale = Math.min(
        host.clientWidth / screen.offsetWidth,
        host.clientHeight / screen.offsetHeight,
      );
      inner.style.transform = `scale(${scale})`;
    };
    solve();
    const observer = new ResizeObserver(solve);
    observer.observe(host);
    const screen = inner.querySelector<HTMLElement>(".xterm-screen");
    if (screen) observer.observe(screen);
    return () => observer.disconnect();
  }, [attached]);

  // The focus contract: focus and blur mirror into the store (deck standdown), Shift+Esc blurs, and an outside click blurs in the CAPTURE phase so it can never double as an advance.
  useEffect(() => {
    const entry = getSceneTerminalSession(key);
    const textarea = entry?.term.textarea;
    if (!entry || !textarea || !attached) return;
    const onFocus = () => {
      focusedRef.current = true;
      setFocused(true);
      setTerminalFocused(true);
    };
    const onBlur = () => {
      focusedRef.current = false;
      setFocused(false);
      setTerminalFocused(false);
    };
    textarea.addEventListener("focus", onFocus);
    textarea.addEventListener("blur", onBlur);
    entry.term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Escape" && e.shiftKey) {
        entry.term.blur();
        return false;
      }
      return true;
    });
    const onClickCapture = (e: MouseEvent) => {
      if (!focusedRef.current) return;
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) {
        e.stopPropagation();
        entry.term.blur();
      }
    };
    document.addEventListener("click", onClickCapture, true);
    return () => {
      textarea.removeEventListener("focus", onFocus);
      textarea.removeEventListener("blur", onBlur);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [key, attached, setTerminalFocused]);

  if (!terminal || !atRest) return null;
  const { grid } = sceneTerminalLayout(terminal, { width: aspect, height: 1 });
  const pct = (v: number) => `${v * 100}%`;
  return (
    <div className="scene-terminal-overlay">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the terminal itself. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the click routes focus, never activation. */}
      <div
        ref={hostRef}
        className={`scene-terminal-host${focused ? " focused" : ""}`}
        style={{
          left: pct(0.5 + grid.left / aspect),
          top: pct(0.5 - grid.top),
          width: pct(grid.width / aspect),
          height: pct(grid.height),
        }}
        title={attached ? undefined : "Click to start the terminal session"}
        onClick={(e) => {
          // Focus, never advance: the surface behind is the advance control.
          e.stopPropagation();
          const entry = getSceneTerminalSession(key);
          if (entry) {
            entry.term.focus();
            return;
          }
          // The custom-start-path session the spawn effect deliberately skipped: this click is the consent.
          if (!colours || !stem || spawnPendingRef.current) return;
          const cwd = terminal.startPath ?? projectFolderPath(project.id);
          if (!cwd) return;
          spawnPendingRef.current = true;
          focusOnAttachRef.current = true;
          void startSceneTerminalSession({ key, cwd, terminal, colours })
            .catch((err) => {
              focusOnAttachRef.current = false;
              console.warn("[present] terminal session start failed:", err);
            })
            .finally(() => {
              spawnPendingRef.current = false;
            });
        }}
      >
        <div ref={scaleRef} className="scene-terminal-scale" />
      </div>
    </div>
  );
}
