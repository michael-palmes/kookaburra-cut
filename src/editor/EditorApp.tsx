import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type EditClip,
  type EditDoc,
  type EditTarget,
  getEditorTarget,
  loadEdit,
  type RenderProgress,
  renderEdit,
  resetEdit,
  saveEdit,
} from "../engine/edit";
import {
  nextClipId,
  nextSourceId,
  relayout,
  removeClip,
  setClipSpeed,
  splitAt,
  timelineDurationMs,
} from "../engine/editMath";
import { formatMediaDuration, type MediaMeta, mediaMeta } from "../engine/media";
import { revealApp } from "../engine/reveal";
import { MediaBrowser } from "../ui/MediaBrowser";
import { Preview, type TrimScrub } from "./Preview";
import { Timeline } from "./Timeline";

/** The non-destructive video editor window: magnetic timeline (trim/split/reorder/speed/zoom, filmstrips), playhead-driven preview with spacebar transport and trim-edge live preview, debounced autosave with warn-on-close and corrupt-doc recovery, multi-clip assembly. Renders close the window on success. */

type RenderState =
  | { phase: "idle" }
  | { phase: "rendering"; frame: number; total: number }
  | { phase: "error"; message: string };

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
const AUTOSAVE_DEBOUNCE_MS = 400;
const WHEEL_PX_PER_FRAME = 4; // horizontal-scroll scrub sensitivity

export function EditorApp() {
  // Fade the UI in on first commit (anti-flash reveal).
  useEffect(() => {
    revealApp();
  }, []);

  const [target, setTarget] = useState<EditTarget | null>(null);
  const [doc, setDoc] = useState<EditDoc | null>(null);
  const [metas, setMetas] = useState<Record<string, MediaMeta | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [render, setRender] = useState<RenderState>({ phase: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trimScrub, setTrimScrub] = useState<TrimScrub | null>(null);
  const [mediaRefresh, setMediaRefresh] = useState(0);

  // Debounced autosave: rapid mutations coalesce into one save; flushSave() runs any pending write before renders (render_edit reads edit.json from disk) and on close. renderStaleRef backs the warn-on-close (changes not yet in a render).
  const saveTimer = useRef<number | null>(null);
  const pendingDoc = useRef<EditDoc | null>(null);
  const renderStaleRef = useRef(false);

  const flushSave = useCallback(async () => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingDoc.current;
    if (!pending || !target) return;
    pendingDoc.current = null;
    try {
      await saveEdit(target.slug, target.name, pending);
    } catch (e) {
      pendingDoc.current = pending; // kept for the next flush attempt
      setSaveError(`Autosave failed: ${String(e)}`);
    }
  }, [target]);
  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;

  // Load the edit for a target (boot + when the main window points us at a different one).
  const load = useCallback((t: EditTarget) => {
    void flushSaveRef.current(); // never lose a pending save from the previous target
    renderStaleRef.current = false;
    setTarget(t);
    setDoc(null);
    setMetas({});
    setError(null);
    setSaveError(null);
    setRender({ phase: "idle" });
    setSelectedId(null);
    setPlayheadMs(0);
    setPlaying(false);
    loadEdit(t.slug, t.name)
      .then((d) => {
        // Normalise on load: the timeline is magnetic, startMs is derived state.
        setDoc({ ...d, clips: relayout(d.clips) });
        // Filmstrips ride the scrub cache (warm for anything the library has shown).
        Promise.all(
          d.sources.map((s) =>
            mediaMeta(t.slug, s.rel)
              .then((m) => [s.id, m] as const)
              .catch(() => [s.id, null] as const),
          ),
        ).then((entries) => setMetas(Object.fromEntries(entries)));
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Boot: read the pending target the main window stashed before opening us.
  useEffect(() => {
    getEditorTarget()
      .then((t) => {
        if (t) load(t);
        else setError("No edit is open. Pick a video in the media library and choose Edit.");
      })
      .catch((e) => setError(String(e)));
  }, [load]);

  // Re-point while open (the main window re-emits when Edit is used on another clip).
  useEffect(() => {
    const unlisten = listen<EditTarget>("kookaburra://editor-target", (e) => load(e.payload));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [load]);

  // Media changed elsewhere (import, cache cleared in Settings) → re-scan the panel.
  useEffect(() => {
    const unlisten = listen("kookaburra://media-changed", () => setMediaRefresh((n) => n + 1));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  /** Commit a document mutation: update state, mark the render stale, schedule autosave. */
  const commitDoc = useCallback((next: EditDoc) => {
    setDoc(next);
    renderStaleRef.current = true;
    pendingDoc.current = next;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushSaveRef.current(), AUTOSAVE_DEBOUNCE_MS);
  }, []);

  /** Commit a clips-only mutation (what the timeline emits). */
  const commit = useCallback(
    (clips: EditClip[]) => {
      if (!doc || !target) return;
      commitDoc({ ...doc, clips });
    },
    [doc, target, commitDoc],
  );

  // Warn on close if there are unrendered changes; the pending autosave always flushes first, so only the render (not the document) is ever at risk.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      await flushSaveRef.current();
      if (renderStaleRef.current) {
        const close = await ask(
          "This edit has changes that haven't been rendered to the project's assets. Close anyway?",
          { title: "Unrendered changes", kind: "warning" },
        );
        if (!close) event.preventDefault();
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  /** Corrupt-document recovery: back it up as .json.bak, recreate from the source; destructive, so it uses the house pattern (native confirm). */
  const handleReset = useCallback(async () => {
    if (!target) return;
    const sure = await ask(
      "Discard this edit and start over from the source video? The current document is kept beside it as a .json.bak backup.",
      { title: "Discard edit", kind: "warning" },
    );
    if (!sure) return;
    resetEdit(target.slug, target.name, target.sourceRel)
      .then(() => load(target))
      .catch((e) => setError(String(e)));
  }, [target, load]);

  // Keep selection and playhead valid as clips change (delete, trim, reorder).
  useEffect(() => {
    if (!doc) return;
    if (selectedId && !doc.clips.some((c) => c.id === selectedId)) setSelectedId(null);
    const durationMs = timelineDurationMs(doc.clips);
    setPlayheadMs((p) => Math.min(p, durationMs));
  }, [doc, selectedId]);

  /** Spacebar transport: toggle playback (restarts from 0 when parked at the end). */
  const togglePlay = useCallback(() => {
    if (!doc || doc.clips.length === 0) return;
    if (!playing && playheadMs >= timelineDurationMs(doc.clips) - 1) setPlayheadMs(0);
    setPlaying(!playing);
  }, [doc, playing, playheadMs]);

  const stopPlaying = useCallback(() => setPlaying(false), []);

  /** A user seek (ruler scrub) pauses playback; playback ticks use setPlayheadMs directly. */
  const handleSeek = useCallback((ms: number) => {
    setPlaying(false);
    setPlayheadMs(ms);
  }, []);

  /** Trim-handle drags drive the viewer to the exact edge frame (and pause playback). */
  const handleTrimScrub = useCallback((scrub: TrimScrub | null) => {
    if (scrub) setPlaying(false);
    setTrimScrub(scrub);
  }, []);

  /** Move the playhead N output frames (arrow keys, wheel scrub) on the frame grid. */
  const stepFrames = useCallback(
    (frames: number) => {
      if (!doc) return;
      const fps = doc.settings.fps > 0 ? doc.settings.fps : 60;
      const frameMs = 1000 / fps;
      const total = timelineDurationMs(doc.clips);
      setPlaying(false);
      setPlayheadMs((p) => {
        const frame = Math.round(p / frameMs) + frames;
        return Math.min(total, Math.max(0, frame * frameMs));
      });
    },
    [doc],
  );

  /** Horizontal wheel/trackpad scrub: N px of scroll per output frame. */
  const wheelRemainder = useRef(0);
  const scrubWheel = useCallback(
    (deltaPx: number) => {
      wheelRemainder.current += deltaPx / WHEEL_PX_PER_FRAME;
      const frames = Math.trunc(wheelRemainder.current);
      if (frames === 0) return;
      wheelRemainder.current -= frames;
      stepFrames(frames);
    },
    [stepFrames],
  );
  const scrubWheelRef = useRef(scrubWheel);
  scrubWheelRef.current = scrubWheel;

  // Wheel over the preview scrubs too (native non-passive listener so preventDefault sticks; the timeline attaches its own inside <Timeline>).
  const stageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      scrubWheelRef.current(delta);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Space plays/pauses; Delete/Backspace removes the selected clip; Escape deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
      // The media panel has its own keyboard semantics, and an open fullscreen preview owns the transport keys (its VideoPlayer handles them).
      if (t?.closest(".editor-media-panel")) return;
      if (document.querySelector(".media-preview")) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const direction = e.key === "ArrowLeft" ? -1 : 1;
        stepFrames(direction * (e.shiftKey ? 10 : 1));
      } else if ((e.key === "Delete" || e.key === "Backspace") && doc && selectedId) {
        e.preventDefault();
        commit(removeClip(doc.clips, selectedId));
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, selectedId, commit, togglePlay, stepFrames]);

  const handleRender = useCallback(async () => {
    if (!target || !doc) return;
    setRender({ phase: "rendering", frame: 0, total: 1 });
    try {
      await flushSave(); // render_edit reads edit.json from disk, so persist the latest doc first
      await renderEdit(target.slug, target.name, (p: RenderProgress) =>
        setRender({ phase: "rendering", frame: p.frame, total: p.total }),
      );
      renderStaleRef.current = false;
      // Success: tell the main window (media library refresh) and close this one.
      await emit("kookaburra://media-changed");
      await getCurrentWindow().close();
    } catch (e) {
      setRender({ phase: "error", message: String(e) });
    }
  }, [target, doc, flushSave]);

  /** Insert a full-length clip of `rel` at clip position `index` (end when omitted); reuses the source entry when this video is already in the edit, and mediaMeta also warms the filmstrip cache. */
  const handleAddClip = useCallback(
    (rel: string, index?: number) => {
      if (!doc || !target) return;
      mediaMeta(target.slug, rel)
        .then((meta) => {
          if (meta.kind !== "video") throw new Error("only videos can be added to an edit");
          const existing = doc.sources.find((s) => s.rel === rel);
          const sourceId = existing?.id ?? nextSourceId(doc.sources);
          const sources = existing
            ? doc.sources
            : [
                ...doc.sources,
                {
                  id: sourceId,
                  rel,
                  width: meta.width,
                  height: meta.height,
                  fps: meta.fps,
                  durationMs: meta.durationMs,
                },
              ];
          const clip: EditClip = {
            id: nextClipId(doc.clips),
            sourceId,
            inMs: 0,
            outMs: meta.durationMs,
            speed: 1,
            startMs: 0,
          };
          const clips = [...doc.clips];
          clips.splice(Math.max(0, Math.min(clips.length, index ?? clips.length)), 0, clip);
          setMetas((prev) => ({ ...prev, [sourceId]: meta }));
          commitDoc({ ...doc, sources, clips: relayout(clips) });
        })
        .catch((e) => setSaveError(`Couldn't add the clip: ${String(e)}`));
    },
    [doc, target, commitDoc],
  );

  const handleSplit = useCallback(() => {
    if (!doc) return;
    const next = splitAt(doc.clips, playheadMs, nextClipId(doc.clips));
    if (next) commit(next);
  }, [doc, playheadMs, commit]);

  const firstSource = doc?.sources[0] ?? null;
  const selectedClip = doc?.clips.find((c) => c.id === selectedId) ?? null;
  const totalMs = doc ? timelineDurationMs(doc.clips) : 0;
  const canSplit = doc ? splitAt(doc.clips, playheadMs, "probe") !== null : false;

  return (
    <div className="editor-window">
      <header className="editor-topbar" data-tauri-drag-region>
        <div className="editor-title" data-tauri-drag-region>
          <span className="editor-name" data-tauri-drag-region>
            {doc?.name ?? target?.name ?? "Editor"}
          </span>
          {doc && (
            <span className="muted editor-settings" data-tauri-drag-region>
              {doc.settings.width}×{doc.settings.height} · {doc.settings.fps.toFixed(0)} fps ·{" "}
              {formatMediaDuration(totalMs)}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn primary editor-render"
          onClick={() => void handleRender()}
          disabled={!doc || doc.clips.length === 0 || render.phase === "rendering"}
          title="Flatten this edit into the project's assets/"
        >
          {render.phase === "rendering"
            ? `Rendering… ${Math.round((render.frame / Math.max(1, render.total)) * 100)}%`
            : "Render to project"}
        </button>
      </header>

      <div className="editor-split">
        {/* The shared MediaBrowser as a persistent side panel: same cards as the main window's Media modal; videos drag into the timeline (this window disables Tauri's native drag-drop handler to free HTML5 DnD). */}
        <aside className="editor-media-panel" aria-label="Project media">
          {target && (
            <MediaBrowser
              slug={target.slug}
              projectPath={target.path}
              refreshKey={mediaRefresh}
              compact
              draggableVideos
              hint="Drag a video into the timeline"
            />
          )}
        </aside>
        <main className="editor-stage" ref={stageRef}>
          {error ? (
            <div className="stage-error" role="alert">
              <h2>This edit can’t open right now</h2>
              <pre>{error}</pre>
              {target?.sourceRel ? (
                <button
                  type="button"
                  className="btn"
                  onClick={handleReset}
                  title="Keeps the broken document beside it as a .json.bak backup"
                >
                  Discard and start over
                </button>
              ) : null}
            </div>
          ) : !doc || !firstSource ? (
            <p className="muted">Loading edit…</p>
          ) : (
            <Preview
              clips={doc.clips}
              sources={doc.sources}
              basePath={target?.path ?? ""}
              playheadMs={playheadMs}
              playing={playing}
              trimScrub={trimScrub}
              onPlayhead={setPlayheadMs}
              onStop={stopPlaying}
            />
          )}
        </main>
      </div>

      {doc && (
        <>
          <div className="editor-toolbar">
            <button
              type="button"
              className="btn editor-play"
              onClick={togglePlay}
              disabled={doc.clips.length === 0}
              title="Play/pause the preview (Space)"
            >
              {playing ? "⏸" : "▶"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleSplit}
              disabled={!canSplit}
              title="Split the clip under the playhead"
            >
              Split
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => selectedId && commit(removeClip(doc.clips, selectedId))}
              disabled={!selectedId}
              title="Delete the selected clip (⌫)"
            >
              Delete
            </button>
            <select
              className="select editor-speed"
              value={selectedClip?.speed ?? 1}
              disabled={!selectedClip}
              onChange={(e) =>
                selectedId && commit(setClipSpeed(doc.clips, selectedId, Number(e.target.value)))
              }
              title="Playback speed of the selected clip"
            >
              {SPEED_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
            <span className="spacer" />
            <span className="muted editor-timecode">
              {(playheadMs / 1000).toFixed(2)}s / {(totalMs / 1000).toFixed(2)}s
            </span>
          </div>
          <Timeline
            clips={doc.clips}
            sources={doc.sources}
            metas={metas}
            selectedId={selectedId}
            playheadMs={playheadMs}
            onSelect={setSelectedId}
            onPlayhead={handleSeek}
            onCommit={commit}
            onTrimScrub={handleTrimScrub}
            onScrubWheel={scrubWheel}
            onDropClip={handleAddClip}
          />
        </>
      )}

      {render.phase === "rendering" && (
        <footer className="editor-progress">
          <div
            className="editor-progress-bar"
            style={{ width: `${(render.frame / Math.max(1, render.total)) * 100}%` }}
          />
        </footer>
      )}
      {render.phase === "error" && (
        <footer className="toast toast-error" role="status">
          <span className="toast-msg" title={render.message}>
            Render failed: {render.message}
          </span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => setRender({ phase: "idle" })}
          >
            ×
          </button>
        </footer>
      )}
      {saveError && (
        <footer className="toast toast-error" role="status">
          <span className="toast-msg" title={saveError}>
            {saveError}
          </span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => setSaveError(null)}
          >
            ×
          </button>
        </footer>
      )}
    </div>
  );
}
