import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { useClockStore } from "../engine/clock";
import { useEffectsStore } from "../engine/effectsStore";
import { type AspectName, FORMATS } from "../engine/format";
import { setPresentSlideshowActive } from "../engine/presentMode";
import { setPreviewAudioProject, syncPreviewAudioPlaying } from "../engine/previewAudio";
import { setPreviewClipStride, setPreviewPlaybackActive } from "../engine/previewMedia";
import { type LoadedProject, loadProject } from "../engine/project";
import { revealApp } from "../engine/reveal";
import { stageOrNull } from "../engine/stageHandle";
import { StageView } from "../stage/StageView";
import { useEditorStore } from "../store/editorStore";
import { PresentTerminalOverlay } from "./PresentTerminalOverlay";
import { PresentWebsiteOverlay } from "./PresentWebsiteOverlay";
import { startPresentAmbience, stopPresentAmbience } from "./presentAmbience";
import { usePresentStore } from "./presentStore";

interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the present window plays; mirrors PresentTarget in src-tauri/src/present.rs. */
export interface PresentTarget {
  projectId: string;
  mode: "video" | "slideshow";
  quality: "full" | "smooth";
  /** The aspect the editor was showing when Present was pressed. */
  aspect: string;
  soundtrack: boolean;
  fullscreen: boolean;
  monitor?: MonitorRect;
}

/** Applies the modal's chosen surface: park on the picked display, then fullscreen. */
async function applySurface(target: PresentTarget): Promise<void> {
  if (!target.fullscreen) return;
  const win = getCurrentWindow();
  if (target.monitor) {
    // Land inside the picked display so fullscreen claims it; a stale rect still fullscreens wherever the window sits.
    try {
      await win.setPosition(new LogicalPosition(target.monitor.x + 50, target.monitor.y + 50));
    } catch (e) {
      console.warn("[present] positioning on the picked display failed", e);
    }
  }
  await win.setFullscreen(true);
}

export function PresentApp() {
  const [target, setTarget] = useState<PresentTarget | null>(null);
  const [project, setProject] = useState<LoadedProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deck = usePresentStore((s) => s.deck);
  const endFade = usePresentStore((s) => s.endFade);
  const videoPaused = usePresentStore((s) => s.videoPaused);
  const committed = usePresentStore((s) => s.scenesCommitted);
  const terminalFocused = usePresentStore((s) => s.terminalFocused);
  const websiteFocused = usePresentStore((s) => s.websiteFocused);
  const [stageReady, setStageReady] = useState(false);
  const mode = target?.mode ?? "slideshow";

  useEffect(() => {
    let live = true;
    void invoke<PresentTarget | null>("get_present_target").then(async (t) => {
      if (!live) return;
      if (t) await applySurface(t).catch((e) => console.warn("[present] surface failed", e));
      if (live) setTarget(t);
      if (!t) revealApp();
    });
    return () => {
      live = false;
    };
  }, []);

  // A re-present while the window is open lands a fresh target; a full reboot is the simplest correct restart.
  useEffect(() => {
    const un = listen("kookaburra://present-target", () => window.location.reload());
    return () => {
      void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    let live = true;
    if (target.quality === "smooth") {
      setPreviewPlaybackActive(true);
      setPreviewClipStride(2);
      stageOrNull()?.previewFlags({ playbackActive: true, clipStride: 2 });
    }
    setPresentSlideshowActive(target.mode === "slideshow");
    stageOrNull()?.previewFlags({ slideshowActive: target.mode === "slideshow" });
    usePresentStore.getState().setMode(target.mode);
    const spec = FORMATS[target.aspect as AspectName] ?? FORMATS["16:9"];
    useEditorStore.getState().setFormat(spec);
    // This window cannot ask for consent (the sheet is the main window's), so it loads only a project whose stored grant still matches; the editor's own writes keep that grant current.
    void loadProject(target.projectId, { trustMode: "stored-only" })
      .then((loaded) => {
        if (!live) return;
        useEditorStore.getState().setTheme(loaded.theme);
        useEffectsStore
          .getState()
          .setProjectEffects(
            loaded.effects,
            loaded.effectOverrides,
            loaded.sceneEffectDefaults,
            loaded.renderSettings,
          );
        const present = usePresentStore.getState();
        present.reset();
        present.setSceneCount(loaded.slots.length);
        const clock = useClockStore.getState();
        if (target.mode === "video") {
          clock.setDurationMs(loaded.totalMs);
          setPreviewAudioProject(loaded);
          syncPreviewAudioPlaying(true);
        } else {
          // No wraparound in a slideshow: local time is steered by anchors, never the duration.
          clock.setDurationMs(Number.MAX_SAFE_INTEGER);
          if (target.soundtrack) startPresentAmbience(loaded);
        }
        clock.setCurrentMs(0);
        setProject(loaded);
        void stageOrNull()?.applyProject(loaded);
        // The loading overlay covers the settle; the window itself can fade in straight away.
        revealApp();
      })
      .catch((e) => {
        if (!live) return;
        setError(
          (e as Error)?.name === "TrustDeniedError"
            ? "This project's files changed since it was opened. Reopen it in the editor, then present again."
            : String(e),
        );
        revealApp();
      });
    return () => {
      live = false;
      stopPresentAmbience();
    };
  }, [target]);

  // The loading overlay lifts on the stable first frame: slideshow once the first scene settles at its hold, video shortly after the scene tree commits.
  useEffect(() => {
    if (!project || stageReady) return;
    if (mode === "slideshow") {
      if (deck.phase !== "entering") setStageReady(true);
      return;
    }
    if (committed) {
      const timer = window.setTimeout(() => setStageReady(true), 300);
      return () => window.clearTimeout(timer);
    }
  }, [project, mode, deck.phase, committed, stageReady]);

  // The session clock: monotonic wall-delta advance; video mode caps at the end and parks.
  useEffect(() => {
    if (!project) return;
    let raf = 0;
    let last: number | null = null;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (last === null) {
        last = now;
        return;
      }
      const dt = Math.min(100, now - last);
      last = now;
      const clock = useClockStore.getState();
      if (mode === "video") {
        // Playback waits for the loading overlay so the opening frames are never hidden.
        if (stageReady && !usePresentStore.getState().videoPaused) {
          clock.setCurrentMs(Math.min(clock.currentMs + dt, project.totalMs));
        }
      } else {
        clock.setCurrentMs(clock.currentMs + dt);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [project, mode, stageReady]);

  // Video-mode soundtrack follows the transport.
  useEffect(() => {
    if (mode === "video" && project) syncPreviewAudioPlaying(!videoPaused);
  }, [mode, project, videoPaused]);

  const advance = useCallback(() => {
    if (!stageReady) return;
    const present = usePresentStore.getState();
    if (mode === "video") {
      present.setVideoPaused(!present.videoPaused);
      return;
    }
    if (present.deck.phase === "end") {
      void getCurrentWindow().close();
      return;
    }
    present.dispatch({ type: "advance" });
  }, [mode, stageReady]);

  const back = useCallback(() => {
    if (!stageReady || mode === "video") return;
    usePresentStore.getState().dispatch({ type: "back" });
  }, [mode, stageReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A focused slide terminal owns the keyboard (Escape included: shells and TUIs use it); Shift+Esc in the terminal hands it back.
      const present = usePresentStore.getState();
      if (present.terminalFocused || present.websiteFocused) return;
      if (e.key === "Escape") {
        const win = getCurrentWindow();
        void win.isFullscreen().then((fs) => (fs ? win.setFullscreen(false) : win.close()));
      } else if (e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        advance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, back]);

  // Cursor hides after a short idle so it never sits over shared content; a focused terminal keeps it, the pointer is in use.
  useEffect(() => {
    if (!project) return;
    if (terminalFocused || websiteFocused) {
      void getCurrentWindow()
        .setCursorVisible(true)
        .catch(() => {});
      return;
    }
    let timer = 0;
    const hide = () =>
      void getCurrentWindow()
        .setCursorVisible(false)
        .catch(() => {});
    const wake = () => {
      void getCurrentWindow()
        .setCursorVisible(true)
        .catch(() => {});
      window.clearTimeout(timer);
      timer = window.setTimeout(hide, 2500);
    };
    wake();
    window.addEventListener("mousemove", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
      void getCurrentWindow()
        .setCursorVisible(true)
        .catch(() => {});
    };
  }, [project, terminalFocused, websiteFocused]);

  const spec = FORMATS[(target?.aspect as AspectName) ?? "16:9"] ?? FORMATS["16:9"];
  const aspect = spec.width / spec.height;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the keydown listener above.
    // biome-ignore lint/a11y/noStaticElementInteractions: the whole surface is the advance control by design.
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
      }}
      onClick={advance}
    >
      {error && (
        <div style={{ color: "#8a93a0", font: "13px -apple-system, sans-serif", maxWidth: 480 }}>
          {error}
        </div>
      )}
      {!error && !target && (
        <div style={{ color: "#4a5560", font: "13px -apple-system, sans-serif" }}>
          Present from a project window
        </div>
      )}
      {project && (
        <div
          style={{
            aspectRatio: `${spec.width} / ${spec.height}`,
            width: `min(100vw, calc(100vh * ${aspect}))`,
            position: "relative",
          }}
        >
          <StageView stageRole="present" dpr={target?.quality === "smooth" ? 1.5 : [1, 2]} />
          {mode === "slideshow" && stageReady && (
            <PresentTerminalOverlay project={project} aspect={aspect} />
          )}
          {mode === "slideshow" && stageReady && (
            <PresentWebsiteOverlay project={project} aspect={aspect} />
          )}
        </div>
      )}
      {mode === "slideshow" && endFade > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "#000",
            opacity: endFade,
            pointerEvents: "none",
          }}
        />
      )}
      {target && !error && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: a passive loading veil; keyboard input is guarded separately.
        // biome-ignore lint/a11y/noStaticElementInteractions: the handlers only swallow clicks while loading.
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "#000",
            display: "grid",
            placeItems: "center",
            color: "#4a5560",
            font: "13px -apple-system, sans-serif",
            opacity: stageReady ? 0 : 1,
            transition: "opacity 350ms ease",
            pointerEvents: stageReady ? "none" : "auto",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {`Opening ${project?.name ?? "…"}`}
        </div>
      )}
      {target && !target.fullscreen && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: an invisible OS drag handle, not an interactive control.
        // biome-ignore lint/a11y/noStaticElementInteractions: the handlers only stop clicks reaching the advance surface.
        <div
          data-tauri-drag-region
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 24 }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
