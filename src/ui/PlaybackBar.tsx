import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { isExporting } from "../engine/exportState";
import { type LoadedProject, sceneFileStem } from "../engine/project";
import { ensureSceneThumbs } from "../engine/sceneThumbs";
import { activeSceneIndex } from "../engine/sceneTimeline";
import { useUiStore } from "../store/uiStore";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { ScenePicker, type WizardSceneInfo } from "./SceneWizards";
import { msFromTrackX, playheadFraction, sceneCellSpans } from "./scrubMath";
import { useEscapeClose } from "./useEscapeClose";

/** Segmented per-scene playback bar: cells tile the track on start boundaries (`sceneCellSpans`) so the playhead lines up with every scene edge; the play button is deliberately not accent-coloured; right-click renames, duplicates, re-times or deletes a scene; disabled while exporting. */
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
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<{ index: number; text: string } | null>(null);
  const [timing, setTiming] = useState<{ index: number; text: string } | null>(null);
  const [duplicating, setDuplicating] = useState<number | null>(null);

  const spans = project ? sceneCellSpans(project.slots, durationMs) : [];
  const active = project ? activeSceneIndex(project.slots, currentMs) : 0;
  const fraction = playheadFraction(currentMs, durationMs);

  const sceneName = (i: number): string => {
    if (!project) return `Scene ${i + 1}`;
    const file = project.sceneFiles[i];
    return project.sceneDocs[i]?.name ?? (file ? sceneFileStem(file) : `Scene ${i + 1}`);
  };

  const openSceneMenu = (e: ReactMouseEvent, index: number) => {
    if (!project || !isWorkspace || exporting || isExporting()) return;
    e.preventDefault();
    const canRename = !!project.sceneDocs[index];
    const lastScene = project.slots.length <= 1;
    // Menus build once per open, so a plain snapshot read is enough.
    const clipboard = useUiStore.getState().backgroundClipboard;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "rename",
          label: "Rename",
          disabled: !canRename,
          title: canRename ? undefined : "This scene has no scene document yet",
          onSelect: () => setRenaming({ index, text: sceneName(index) }),
        },
        {
          id: "duplicate",
          label: "Duplicate…",
          onSelect: () => setDuplicating(index),
        },
        {
          id: "duration",
          label: "Change duration…",
          onSelect: () =>
            setTiming({
              index,
              text: ((project.slots[index]?.durationMs ?? 0) / 1000).toFixed(2),
            }),
        },
        "separator",
        {
          id: "copy-background",
          label: "Copy background",
          onSelect: () => {
            const doc = project.sceneDocs[index];
            useUiStore.getState().setBackgroundClipboard({
              background: doc?.background ? structuredClone(doc.background) : undefined,
              backdrop: doc?.backdrop ? structuredClone(doc.backdrop) : undefined,
            });
          },
        },
        {
          id: "paste-background",
          label: "Paste background",
          disabled: !clipboard,
          title: clipboard ? undefined : "Copy a scene's background first",
          onSelect: () => onPasteBackground(index),
        },
        "separator",
        {
          id: "delete",
          label: "Delete",
          confirmLabel: "Really delete?",
          danger: true,
          disabled: lastScene,
          title: lastScene ? "A project needs at least one scene" : undefined,
          onSelect: () => onDeleteScene(index),
        },
      ],
    });
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
    const seconds = Number(t.text);
    // The inspector DurationRow's floor: junk and sub-100ms values are dropped silently.
    if (!Number.isFinite(seconds) || seconds < 0.1) return;
    const ms = Math.round(seconds * 1000);
    if (ms !== project.slots[t.index]?.durationMs) onSceneDuration(t.index, ms);
  };

  const scrubTo = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    onScrub(msFromTrackX(clientX - rect.left, rect.width, durationMs));
  };

  return (
    <div className="playback-bar">
      <div className="pb-left">
        <button
          type="button"
          ref={playRef}
          className="play-btn"
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
      </div>

      <div className="pb-center">
        {/* Keyboard access rides the app-wide transport keydown (←/→ frame-step). */}
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
          onPointerDown={(e) => {
            // isExporting() also guards autorun exports, not just the UI-disabled state; a right-click opens the scene menu instead of scrubbing.
            if (e.button !== 0 || exporting || isExporting() || !project) return;
            // A drag must never start a native text selection.
            e.preventDefault();
            scrubbing.current = true;
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
            scrubTo(e.clientX);
          }}
          onPointerMove={(e) => {
            if (scrubbing.current && !isExporting()) scrubTo(e.clientX);
          }}
          onPointerUp={(e) => {
            scrubbing.current = false;
            (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            scrubbing.current = false;
          }}
          onContextMenu={(e) => {
            // The expanded hit zone (.pb-track::before) sits over the cells, so the menu opens from the track itself; the scene comes from the pointer X.
            if (!project) return;
            const rect = trackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const ms = msFromTrackX(e.clientX - rect.left, rect.width, durationMs);
            const index =
              ms >= durationMs ? project.slots.length - 1 : activeSceneIndex(project.slots, ms);
            openSceneMenu(e, index);
          }}
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
                className="modal-input pb-label-input"
                style={{ flexGrow: span.weight }}
                value={timing.text}
                inputMode="decimal"
                // biome-ignore lint/a11y/noAutofocus: entered from the context menu — it IS the focus target
                autoFocus
                aria-label="Scene duration in seconds"
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
              >
                {sceneName(span.index)}
              </span>
            ),
          )}
        </div>
      </div>

      <div className="pb-right">
        <span className="pb-readout">{readout}</span>
        {isWorkspace && (
          <button
            type="button"
            className="pb-new-scene"
            disabled={exporting}
            title="Add a scene (opens the scene wizard)"
            onClick={onNewScene}
          >
            ＋ New scene
          </button>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
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

/** Placement dialog for Duplicate: the New-scene "Where?" picker seeded to "after the source"; thumbs are best-effort (`ensureSceneThumbs` returns what it has, cards degrade to placeholders). */
function DuplicateSceneDialog({
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
    let cancelled = false;
    void ensureSceneThumbs(project).then((t) => {
      if (!cancelled) setThumbs(t);
    });
    return () => {
      cancelled = true;
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
      <div className="modal wizard-wide">
        <h2>Duplicate “{sourceName}”</h2>
        <p className="modal-hint">Where should the copy go?</p>
        <ScenePicker
          scenes={scenes}
          thumbs={thumbs}
          mode="placement"
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
