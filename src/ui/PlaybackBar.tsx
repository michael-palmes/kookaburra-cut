import { listen } from "@tauri-apps/api/event";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { isExporting } from "../engine/exportState";
import {
  type AudioMarkersSpec,
  type LoadedProject,
  sceneFileStem,
  workspaceSlug,
} from "../engine/project";
import { ensureSceneThumbs, listCachedSceneThumbs } from "../engine/sceneThumbs";
import { activeSceneIndex } from "../engine/sceneTimeline";
import { useUiStore } from "../store/uiStore";
import { BeatLane } from "./BeatLane";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { CopySceneModal } from "./CopySceneModal";
import { formatSceneLengthMs, parseSceneLengthMs } from "./durationText";
import { SceneInsertTimeline } from "./SceneInsertTimeline";
import type { WizardSceneInfo } from "./SceneWizards";
import { sceneMenuItems } from "./sceneMenu";
import { msFromTrackX, playheadFraction, sceneCellSpans } from "./scrubMath";
import { useEscapeClose } from "./useEscapeClose";

/** Segmented per-scene playback bar: cells tile the track on ATTRIBUTION boundaries (`sceneCellSpans`, mid-transition to mid-transition) so the drawn scene change sits halfway through each overlap and the bold name agrees with its cell; the play button is deliberately not accent-coloured; right-click renames, duplicates, re-times or deletes a scene; disabled while exporting. */
export function PlaybackBar({
  project,
  playing,
  exporting,
  currentMs,
  durationMs,
  readout,
  hasAudio,
  audioMuted,
  isWorkspace,
  playRef,
  onTogglePlay,
  onToggleMute,
  onScrub,
  onNewScene,
  onRenameScene,
  onDeleteScene,
  onDuplicateScene,
  onSceneDuration,
  onPasteBackground,
  onUpdateAudioMarkers,
  onAddCameraKeyAtBeat,
  onSyncCameraToBeats,
}: {
  project: LoadedProject | null;
  playing: boolean;
  exporting: boolean;
  currentMs: number;
  durationMs: number;
  /** The mono readout text (the host keeps the error-string fallback). */
  readout: string;
  hasAudio: boolean;
  audioMuted: boolean;
  isWorkspace: boolean;
  /** Host's play-button ref; its Space-key guard keys off it. */
  playRef: RefObject<HTMLButtonElement | null>;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  /** Seek (already guarded by the host: isExporting + replay ownership). */
  onScrub: (ms: number) => void;
  onNewScene: () => void;
  /** Commit an in-place rename (the host writes `doc.name` + history). */
  onRenameScene: (index: number, name: string) => void;
  /** Trash-recoverable scene removal (the host reloads; Rust guards the last scene). */
  onDeleteScene: (index: number) => void;
  /** Copy a scene to `position` (the host reloads; a new TSX needs the module reload token). */
  onDuplicateScene: (index: number, position?: number) => Promise<void>;
  /** Commit a scene length in ms (the host writes project.json + the manual-mode flip). */
  onSceneDuration: (index: number, ms: number) => void;
  /** Write the copied background + staging onto a scene (the host owns the write + history). */
  onPasteBackground: (index: number) => void;
  /** Write (or null to clear) the manifest's `audio.markers` (the host owns the write + history). */
  onUpdateAudioMarkers: (markers: AudioMarkersSpec | null) => void;
  /** Add one camera keyframe landing on the beat at project-time ms (the host resolves the scene). */
  onAddCameraKeyAtBeat: (ms: number) => void;
  /** Generate the owning scene's camera track from its key beats (the host resolves the scene). */
  onSyncCameraToBeats: (ms: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const beatLaneHidden = useUiStore((s) => s.beatLaneHidden);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [copying, setCopying] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ index: number; text: string } | null>(null);
  const [timing, setTiming] = useState<{ index: number; text: string } | null>(null);
  const [duplicating, setDuplicating] = useState<number | null>(null);

  const spans = project ? sceneCellSpans(project.slots, durationMs) : [];
  const active = project ? activeSceneIndex(project.slots, currentMs) : 0;
  const fraction = playheadFraction(currentMs, durationMs, spans);

  const sceneName = (i: number): string => {
    if (!project) return `Scene ${i + 1}`;
    const file = project.sceneFiles[i];
    return project.sceneDocs[i]?.name ?? (file ? sceneFileStem(file) : `Scene ${i + 1}`);
  };

  const openSceneMenu = (e: ReactMouseEvent, index: number) => {
    if (!project || !isWorkspace || exporting || isExporting()) return;
    e.preventDefault();
    // Menus build once per open, so a plain snapshot read is enough.
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: sceneMenuItems({
        canRename: !!project.sceneDocs[index],
        canDelete: project.slots.length > 1,
        hasClipboard: !!useUiStore.getState().backgroundClipboard,
        onRename: () => setRenaming({ index, text: sceneName(index) }),
        onDuplicate: () => setDuplicating(index),
        onDuration: () =>
          setTiming({ index, text: formatSceneLengthMs(project.slots[index]?.durationMs ?? 0) }),
        onCopyBackground: () => {
          const doc = project.sceneDocs[index];
          useUiStore.getState().setBackgroundClipboard({
            background: doc?.background ? structuredClone(doc.background) : undefined,
            backdrop: doc?.backdrop ? structuredClone(doc.backdrop) : undefined,
          });
        },
        onPasteBackground: () => onPasteBackground(index),
        onDelete: () => onDeleteScene(index),
        onCopyToProject: () => setCopying(index),
        onManage: () => {
          const ui = useUiStore.getState();
          ui.setInspectorTab("project");
          ui.jumpInspectorDrill(["project.scenes"]);
        },
      }),
    });
  };

  // Double-click renames in place (same guards as the context menu's Rename).
  const startRename = (index: number) => {
    if (!project || !isWorkspace || exporting || isExporting()) return;
    if (!project.sceneDocs[index]) return;
    setRenaming({ index, text: sceneName(index) });
  };

  const finishRename = (commit: boolean) => {
    const r = renaming;
    setRenaming(null);
    if (!commit || !r) return;
    const text = r.text.trim();
    if (text === sceneName(r.index)) return;
    onRenameScene(r.index, text);
  };

  const finishTiming = (commit: boolean) => {
    const t = timing;
    setTiming(null);
    if (!commit || !t || !project) return;
    const ms = parseSceneLengthMs(t.text);
    if (ms === null) return;
    if (ms !== project.slots[t.index]?.durationMs) onSceneDuration(t.index, ms);
  };

  /** Pointer x → clock ms through the track's rect, so every surface in the bar scrubs exactly like the track itself; null while the track is unmounted. */
  const trackMsAt = (clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return msFromTrackX(clientX - rect.left, rect.width, durationMs, spans);
  };

  const scrubTo = (clientX: number) => {
    const ms = trackMsAt(clientX);
    if (ms !== null) onScrub(ms);
  };

  const sceneAt = (clientX: number): number | null => {
    const ms = trackMsAt(clientX);
    if (ms === null || !project) return null;
    return ms >= durationMs ? project.slots.length - 1 : activeSceneIndex(project.slots, ms);
  };

  /** Interactive children opt out of the surrounding scrub surface. */
  const holdPointer = (e: ReactPointerEvent) => e.stopPropagation();

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-driven scrub surface (keyboard access rides the app-wide transport keydown) plus the right-click scene menu
    <div
      className="playback-bar"
      onPointerDown={(e) => {
        // isExporting() also guards autorun exports, not just the UI-disabled state; a right-click opens the scene menu instead of scrubbing.
        if (e.button !== 0 || exporting || isExporting() || !project) return;
        // The scene menu and its dialogs float above the bar but are DOM descendants: their clicks are never scrub input (preventDefault + pointer capture here would eat every menu item).
        if ((e.target as HTMLElement).closest(".context-menu, .modal-overlay")) return;
        const label = (e.target as HTMLElement).closest<HTMLElement>(".pb-label");
        // A drag must never start a native text selection; labels keep their default, and capture on the label itself, so the click/double-click pair still targets it (rename) instead of the capturing bar.
        if (!label) e.preventDefault();
        scrubbing.current = true;
        (label ?? (e.currentTarget as HTMLDivElement)).setPointerCapture(e.pointerId);
        scrubTo(e.clientX);
      }}
      onPointerMove={(e) => {
        if (scrubbing.current && !isExporting()) scrubTo(e.clientX);
      }}
      onPointerUp={(e) => {
        scrubbing.current = false;
        const el = e.currentTarget as HTMLDivElement;
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        scrubbing.current = false;
      }}
      onContextMenu={(e) => {
        // The labels handle their own right-clicks (defaultPrevented); everything else clamps into the track to resolve a scene.
        if (e.defaultPrevented || !project) return;
        const index = sceneAt(e.clientX);
        if (index !== null) openSceneMenu(e, index);
      }}
    >
      <div className="pb-left">
        <button
          type="button"
          ref={playRef}
          className="play-btn"
          onPointerDown={holdPointer}
          onClick={onTogglePlay}
          disabled={!project || exporting}
          aria-label={playing ? "Pause (Space)" : "Play (Space)"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="2.5" y="1.5" width="3" height="11" rx="1" fill="currentColor" />
              <rect x="8.5" y="1.5" width="3" height="11" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3.5 2.2c0-.5.53-.8.96-.54l7 4.8a.64.64 0 0 1 0 1.08l-7 4.8a.64.64 0 0 1-.96-.54V2.2z"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
        {hasAudio && (
          <button
            type="button"
            className={`pb-mute${audioMuted ? " muted" : ""}`}
            aria-pressed={audioMuted}
            title={
              audioMuted
                ? "Unmute the soundtrack (preview only)"
                : "Mute the soundtrack (preview only)"
            }
            onPointerDown={holdPointer}
            onClick={onToggleMute}
          >
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M4 8v4h3l4 3.5v-11L7 8H4z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinejoin="round"
              />
              {audioMuted ? (
                <path d="M13.5 8l4 4m0-4l-4 4" stroke="currentColor" strokeWidth="1.5" />
              ) : (
                <path
                  d="M13.5 7.5a3.6 3.6 0 010 5m2-7a6.4 6.4 0 010 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
        )}
        {hasAudio && (
          <button
            type="button"
            className={`pb-mute pb-beats${beatLaneHidden ? " muted" : ""}`}
            aria-pressed={!beatLaneHidden}
            title={beatLaneHidden ? "Show the beat lane" : "Hide the beat lane"}
            onPointerDown={holdPointer}
            onClick={() => useUiStore.getState().setBeatLaneHidden(!beatLaneHidden)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect
                x="4.2"
                y="4.2"
                width="5.6"
                height="5.6"
                rx="1"
                transform="rotate(45 7 7)"
                fill={beatLaneHidden ? "none" : "currentColor"}
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          </button>
        )}
      </div>

      <div className="pb-center">
        {hasAudio && project && !beatLaneHidden && (
          <BeatLane
            project={project}
            durationMs={durationMs}
            isWorkspace={isWorkspace}
            onSeek={onScrub}
            onUpdateMarkers={onUpdateAudioMarkers}
            onAddCameraKey={onAddCameraKeyAtBeat}
            onSyncCamera={onSyncCameraToBeats}
          />
        )}
        {/* The scrub handlers live on the whole bar (they map against this rect); keyboard access rides the app-wide transport keydown (←/→ frame-step). */}
        <div
          ref={trackRef}
          className={`pb-track${exporting ? " disabled" : ""}`}
          role="slider"
          tabIndex={exporting ? -1 : 0}
          aria-label="Timeline"
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs)}
          aria-valuenow={Math.round(currentMs)}
          aria-valuetext={readout}
        >
          {spans.map((span) => (
            <div
              key={span.index}
              className={`pb-cell${span.index === active ? " active" : ""}`}
              style={{ flexGrow: span.weight }}
            />
          ))}
          <div className="pb-playhead" style={{ left: `${fraction * 100}%` }} />
        </div>
        <div className="pb-labels">
          {spans.map((span) =>
            renaming?.index === span.index ? (
              <input
                key={span.index}
                className="modal-input pb-label-input"
                style={{ flexGrow: span.weight }}
                value={renaming.text}
                // biome-ignore lint/a11y/noAutofocus: entered from the context menu — it IS the focus target
                autoFocus
                aria-label="Scene name"
                onPointerDown={holdPointer}
                onChange={(e) => setRenaming({ index: span.index, text: e.target.value })}
                onBlur={() => finishRename(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") finishRename(false);
                }}
              />
            ) : timing?.index === span.index ? (
              <input
                key={span.index}
                className="modal-input pb-label-input pb-label-duration"
                style={{ flexGrow: span.weight }}
                value={timing.text}
                // biome-ignore lint/a11y/noAutofocus: entered from the context menu — it IS the focus target
                autoFocus
                aria-label="Scene length in minutes and seconds"
                onPointerDown={holdPointer}
                onChange={(e) => setTiming({ index: span.index, text: e.target.value })}
                onBlur={() => finishTiming(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") finishTiming(false);
                }}
              />
            ) : (
              // biome-ignore lint/a11y/noStaticElementInteractions: right-click menu only — the label is read-only chrome
              <span
                key={span.index}
                className={`pb-label${span.index === active ? " active" : ""}`}
                style={{ flexGrow: span.weight }}
                title={sceneName(span.index)}
                onContextMenu={(e) => openSceneMenu(e, span.index)}
                onDoubleClick={() => startRename(span.index)}
              >
                {sceneName(span.index)}
              </span>
            ),
          )}
        </div>
      </div>

      <div className="pb-right">
        <span className="pb-readout" onPointerDown={holdPointer}>
          {readout}
        </span>
        {isWorkspace && (
          <button
            type="button"
            className="pb-new-scene"
            disabled={exporting}
            title="Add a scene (opens the scene wizard)"
            onPointerDown={holdPointer}
            onClick={onNewScene}
          >
            ＋ New scene
          </button>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {copying !== null && project && (
        <CopySceneModal
          slug={workspaceSlug(project.id)}
          indices={[copying]}
          sceneLabel={`“${sceneName(copying)}”`}
          onDone={() => setCopying(null)}
          onCancel={() => setCopying(null)}
        />
      )}
      {duplicating !== null && project && (
        <DuplicateSceneDialog
          project={project}
          index={duplicating}
          sourceName={sceneName(duplicating)}
          onClose={() => setDuplicating(null)}
          onDuplicate={onDuplicateScene}
        />
      )}
    </div>
  );
}

/** Placement dialog for Duplicate: the New-scene "Where?" insert strip seeded to "after the source"; thumbs are best-effort (`ensureSceneThumbs` returns what it has, cards degrade to placeholders). Shared with the Scenes drill-in's context menu. */
export function DuplicateSceneDialog({
  project,
  index,
  sourceName,
  onClose,
  onDuplicate,
}: {
  project: LoadedProject;
  index: number;
  sourceName: string;
  onClose: () => void;
  onDuplicate: (index: number, position?: number) => Promise<void>;
}) {
  const [placement, setPlacement] = useState(`after:${index}`);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, !busy);
  useEffect(() => {
    const controller = new AbortController();
    void ensureSceneThumbs(project, { signal: controller.signal }).then((t) => {
      if (!controller.signal.aborted) setThumbs(t);
    });
    // Fresh thumbs land asynchronously from the render window; repaint as they arrive.
    const stop = listen("kookaburra://thumbs-updated", () => {
      void listCachedSceneThumbs(project).then((t) => {
        if (!controller.signal.aborted) setThumbs(t);
      });
    });
    return () => {
      controller.abort();
      void stop.then((unlisten) => unlisten());
    };
  }, [project]);
  const scenes: WizardSceneInfo[] = project.slots.map((s, i) => ({
    index: i,
    id: s.id,
    file: project.sceneFiles[i],
    stem: sceneFileStem(project.sceneFiles[i]),
    name: project.sceneDocs[i]?.name ?? null,
    durationMs: s.durationMs,
    startMs: s.startMs,
    doc: project.sceneDocs[i],
  }));
  const submit = async () => {
    setBusy(true);
    const position =
      placement === "start"
        ? 0
        : placement === "end"
          ? undefined
          : Number(placement.slice("after:".length)) + 1;
    // The host toasts failures; the dialog just closes either way (success reloads the project).
    await onDuplicate(index, position);
    onClose();
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Duplicate scene">
      <div className="modal wizard-wide wizard-place-wide">
        <h2>Duplicate “{sourceName}”</h2>
        <p className="modal-hint">Where should the copy go?</p>
        <SceneInsertTimeline
          scenes={scenes}
          thumbs={thumbs}
          value={placement}
          onChange={setPlacement}
        />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? "Duplicating…" : "Duplicate"}
          </button>
        </div>
      </div>
    </div>
  );
}
