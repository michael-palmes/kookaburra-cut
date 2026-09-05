import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import {
  type LoadedProject,
  nativeProjectSlug,
  projectFolderPath,
  sceneFileStem,
} from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { resolveSceneTerminal, sceneTerminalLayout } from "../engine/sceneTerminal";
import { bakeTerminalSnapshot } from "../engine/sceneTerminalBake";
import { type CaptureTerminal, captureTerminalSnapshot } from "../engine/sceneTerminalCapture";
import {
  applySceneTerminalSettings,
  getSceneTerminalSession,
  type SceneTerminalStatus,
  sceneTerminalKey,
  sceneTerminalSessionsVersion,
  startSceneTerminalSession,
  subscribeSceneTerminalSessions,
} from "../engine/sceneTerminalSession";
import { resolveTerminalColours } from "../engine/sceneTerminalTheme";
import { useEditorStore } from "../store/editorStore";
import { useGizmoDocWrite } from "./gizmo/gizmoDocWrite";

/** The interactive terminal over the active scene's panel: a DOM xterm scaled onto the block's grid area, mounted between the canvas and the gizmo layers. The chrome (title bar, lights, bezel) stays WebGL beneath; the live xterm paints the same screen colour, so it sits seamlessly over the baked snapshot. Sessions live in the scene-terminal registry and survive unmount (the rail rule); the overlay shows only while playback is paused, since a transition slides the panel while DOM stays put. Click to focus (the deck-parity model), click outside or Shift+Esc to leave; plain Esc belongs to the shell (vim, Claude Code). Leaving focus, the scene, or unmounting auto-recaptures the snapshot, so the baked pixels track the live session. */

const CHIP_PLAY = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 1.8v8.4L10 6z" fill="currentColor" />
  </svg>
);

export function SceneTerminalOverlay({
  project,
  sceneIndex,
  aspect,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  /** Frame aspect (width / height), for the layout's frame-fraction maths. */
  aspect: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const doc = project.sceneDocs[sceneIndex] ?? null;
  const theme = project.sceneThemes[sceneIndex] ?? project.theme;
  const terminal = useMemo(() => resolveSceneTerminal(doc ?? undefined), [doc]);
  const colours = useMemo(
    () => (terminal ? resolveTerminalColours(terminal.theme, theme) : null),
    [terminal, theme],
  );
  const playing = useEditorStore((s) => s.playing);
  const cameraArmed = useCameraEditStore((s) => s.armedTool !== null);
  const { commit } = useGizmoDocWrite(project, sceneIndex, onDocChanged);

  const slug = nativeProjectSlug(project.id);
  const stem = sceneFileStem(project.sceneFiles[sceneIndex] ?? "");
  const key = sceneTerminalKey(slug, stem);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<SceneTerminalStatus | "idle">("idle");
  const [focused, setFocused] = useState(false);
  /** True once this focus session touched the terminal, so blur knows a capture is owed. */
  const dirty = useRef(false);

  // Latest capture inputs for unmount cleanup, which must not re-run on every doc change.
  const captureRef = useRef<() => void>(() => {});

  const capture = useCallback(() => {
    const entry = getSceneTerminalSession(key);
    if (!entry || !terminal || !dirty.current) return;
    dirty.current = false;
    const snapshot = captureTerminalSnapshot(entry.term as unknown as CaptureTerminal);
    void (async () => {
      try {
        const src = await bakeTerminalSnapshot(project.id, stem, { ...terminal, snapshot }, theme);
        await commit(
          doc,
          (next) => {
            next.terminal = { ...(next.terminal ?? {}), snapshot: { ...snapshot, src } };
          },
          "capture terminal snapshot",
        );
      } catch (e) {
        console.warn("[terminal] snapshot capture failed:", e);
      }
    })();
  }, [key, terminal, theme, project.id, stem, doc, commit]);
  captureRef.current = capture;

  // The registry version, so a session the inspector drill starts (or kills) reaches this mounted overlay.
  const sessionsTick = useSyncExternalStore(
    subscribeSceneTerminalSessions,
    sceneTerminalSessionsVersion,
    sceneTerminalSessionsVersion,
  );
  /** Set when this overlay asked for the session, so the attach below focuses it once open. */
  const focusOnAttach = useRef(false);

  // Attach the live session's DOM: a fresh terminal opens here (fonts first, glyph metrics are measured at open), a surviving one re-appends with scrollback intact; detach without killing on the way out, capturing first (the scene-leave rule). Keyed by session identity alone: capture rides the ref so doc churn can't re-run the attach.
  useEffect(() => {
    void sessionsTick;
    let cancelled = false;
    void (async () => {
      const entry = getSceneTerminalSession(key);
      const host = scaleRef.current;
      if (!entry || !host) {
        setStatus("idle");
        return;
      }
      if (!entry.term.element) {
        await document.fonts.ready;
        if (cancelled) return;
        entry.term.open(host);
      } else if (entry.term.element.parentElement !== host) {
        host.appendChild(entry.term.element);
      }
      entry.notify = setStatus;
      setStatus(entry.status);
      if (focusOnAttach.current) {
        focusOnAttach.current = false;
        dirty.current = true;
        entry.term.focus();
      }
    })();
    return () => {
      cancelled = true;
      captureRef.current();
      const live = getSceneTerminalSession(key);
      if (live) {
        live.notify = undefined;
        live.term.element?.remove();
      }
      setFocused(false);
    };
  }, [key, sessionsTick]);

  // The live session follows the sidecar's theme, font size and grid size.
  useEffect(() => {
    const entry = getSceneTerminalSession(key);
    if (entry && terminal && colours) applySceneTerminalSettings(entry, terminal, colours);
  }, [key, terminal, colours]);

  // Fit the xterm's natural pixel size onto the grid rect: uniform scale, top-left anchored, re-solved when the stage resizes.
  useEffect(() => {
    const host = hostRef.current;
    const inner = scaleRef.current;
    if (!host || !inner || status === "idle") return;
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
  }, [status]);

  // Focus tracking + the blur rules: click outside leaves, Shift+Esc leaves, plain Esc stays with the shell.
  useEffect(() => {
    const entry = getSceneTerminalSession(key);
    const textarea = entry?.term.textarea;
    if (!entry || !textarea || status === "idle") return;
    const onFocus = () => {
      dirty.current = true;
      setFocused(true);
    };
    const onBlur = () => {
      setFocused(false);
      captureRef.current();
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
    const onOutside = (e: PointerEvent) => {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) entry.term.blur();
    };
    document.addEventListener("pointerdown", onOutside);
    return () => {
      textarea.removeEventListener("focus", onFocus);
      textarea.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, [key, status]);

  const start = useCallback(async () => {
    if (!terminal || !colours) return;
    const cwd = terminal.startPath ?? projectFolderPath(project.id);
    if (!cwd) return;
    // The registry bump re-runs the attach effect, which opens and focuses the fresh terminal.
    focusOnAttach.current = true;
    try {
      await startSceneTerminalSession({ key, cwd, terminal, colours });
    } catch (e) {
      focusOnAttach.current = false;
      console.warn("[terminal] session start failed:", e);
    }
  }, [key, project.id, terminal, colours]);

  if (!terminal || playing) return null;
  const layout = sceneTerminalLayout(terminal, { width: aspect, height: 1 });
  const { grid } = layout;
  const pct = (v: number) => `${v * 100}%`;
  const gridStyle = {
    left: pct(0.5 + grid.left / aspect),
    top: pct(0.5 - grid.top),
    width: pct(grid.width / aspect),
    height: pct(grid.height),
  };

  return (
    <div
      className="scene-terminal-overlay"
      style={cameraArmed ? { pointerEvents: "none" } : undefined}
    >
      <div
        ref={hostRef}
        className={`scene-terminal-host${focused ? " focused" : ""}`}
        style={gridStyle}
      >
        <div ref={scaleRef} className="scene-terminal-scale" />
        {status !== "running" && (
          <button
            type="button"
            // With a snapshot in place the chip waits for hover, so captured content stays legible.
            className={`scene-terminal-chip${terminal.snapshot?.src ? " quiet" : ""}`}
            onClick={start}
          >
            {CHIP_PLAY}
            {status === "exited" ? "Restart session" : "Start session"}
          </button>
        )}
      </div>
    </div>
  );
}
