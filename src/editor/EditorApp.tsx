import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEVICE_SCREEN_SLOTS,
  type DeviceScreenSlot,
  deviceSlotMedia,
} from "../engine/deviceScreens";
import {
  type EditClip,
  type EditDoc,
  type EditEntry,
  type EditMask,
  type EditMaskStyle,
  type EditSource,
  type EditTarget,
  type EditWrite,
  editStamps,
  getEditorTarget,
  listEdits,
  loadEdit,
  loadEditEntry,
  openEdit,
  openEditNamed,
  type RenderProgress,
  renderEdit,
  resetEdit,
  saveEdit,
} from "../engine/edit";
import {
  keyIndexAt,
  keyToleranceMs,
  type MaskRect,
  pruneOrphanMasks,
  removeMaskKey,
  replaceMask,
  type SourceMoment,
  sourceMomentAt,
} from "../engine/editMasks";
import {
  clipIndexAt,
  DEFAULT_HOLD_MS,
  freezeAt,
  freezeAtEnd,
  outputToSource,
  relayout,
  splitAt,
  tapWindows,
  timelineDurationMs,
} from "../engine/editMath";
import { applyEditOp, type EditOp, type EditOpResult, type SourceMeta } from "../engine/editOps";
import { formatMediaDuration, importMediaBytes, type MediaMeta, mediaMeta } from "../engine/media";
import { readProjectManifestSnapshot } from "../engine/projectEdit";
import { revealApp } from "../engine/reveal";
import { parseSceneDoc } from "../engine/sceneDocSchema";
import { resolveSceneDocMedia } from "../engine/sceneMedia";
import { resolveAvailableDeviceSpec } from "../toolkit/device/catalog";
import { ContextMenu, type ContextMenuState } from "../ui/ContextMenu";
import { MediaBrowser } from "../ui/MediaBrowser";
import { mediaCardMenu } from "../ui/mediaCardMenu";
import { hasPendingTextEdit, spaceMeansPlayback } from "../ui/textEditFocus";
import { useEscapeClose } from "../ui/useEscapeClose";
import {
  adoptOwnWrite,
  createEditStampState,
  describeDropped,
  type EditSyncIO,
  type EditWatch,
  mergeEditDocs,
  pollEdit,
  resetEditStamp,
  sameValue,
  saveWithRebase,
} from "./editLiveSync";
import {
  bindEditorHistory,
  closeEditorHistoryCoalescing,
  pushEditorHistory,
  pushExternalEditorHistory,
  takeEditorRedo,
  takeEditorUndo,
} from "./editorHistory";
import { MaskSettingsBar } from "./MaskSettingsBar";
import { Preview, type TrimScrub } from "./Preview";
import { ReferencePane } from "./ReferencePane";
import { speedChoices } from "./speedOptions";
import { Timeline } from "./Timeline";
import { ToolIcon } from "./ToolIcon";
import { TAP_ANIMATION_DURATION_MS, tapGradient } from "./tapAnimation";
import {
  DEFAULT_TAP_COLOR_ID,
  DEFAULT_TAP_STYLE_ID,
  TAP_COLORS,
  TAP_STYLES,
} from "./tapStyles.generated";

/** The non-destructive video editor window: magnetic timeline (trim/split/reorder/speed/zoom, filmstrips), playhead-driven preview with spacebar transport and trim-edge live preview, debounced autosave with warn-on-close and corrupt-doc recovery, multi-clip assembly. Still images join as freeze clips (default hold, retimed by the same handle). Renders close the window on success. */

type RenderState =
  | { phase: "idle" }
  | { phase: "rendering"; frame: number; total: number }
  | { phase: "error"; message: string }
  | { phase: "changed" };

const AUTOSAVE_DEBOUNCE_MS = 400;
/** Live sync polls the doc's stamp this often (and on window focus); a change applies once two polls agree. */
const LIVE_POLL_MS = 1000;
const EDIT_IO: EditSyncIO = { stamps: editStamps, load: loadEditEntry, save: saveEdit };

/** The doc as the editor last read or wrote it: the three-way merge base and the save's base hash. */
interface EditBase {
  slug: string;
  name: string;
  hash: string;
  doc: EditDoc;
}

const laidOut = (doc: EditDoc): EditDoc => ({ ...doc, clips: relayout(doc.clips) });
/** A document from a newer app (edit.rs `parse_doc`): discarding it would throw away work that app can still open. */
const VERSION_ERROR = /needs a newer Kookaburra Cut/;
const WHEEL_PX_PER_FRAME = 4; // horizontal-scroll scrub sensitivity

/** The tap-settings strip under the topbar: marker scope, style dropdown with live swatches, colour dots and size, centred full-width. */
function TapSettingsBar({
  scope,
  onScope,
  styleId,
  onStyle,
  colorId,
  onColor,
  size,
  onSize,
  onSizeCommit,
}: {
  scope: "near" | "all";
  onScope: (scope: "near" | "all") => void;
  styleId: string;
  onStyle: (id: string) => void;
  colorId: string;
  onColor: (id: string) => void;
  size: number;
  onSize: (size: number) => void;
  onSizeCommit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEscapeClose(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  const style = TAP_STYLES.find((s) => s.id === styleId) ?? TAP_STYLES[0];
  const color = TAP_COLORS.find((c) => c.id === colorId) ?? TAP_COLORS[0];
  // The swatch backdrop splits light/dark so every style's visibility is previewable; the dot layer draws at 82% so its silhouette never touches the chip's edge.
  const swatch = (gradient: string): CSSProperties => ({
    backgroundImage: `${gradient}, linear-gradient(105deg, #f2f2f2 50%, #20262b 50%)`,
    backgroundSize: "82% 82%, 100% 100%",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  });
  return (
    <div className="tap-settings" ref={ref}>
      <div className="tap-settings-scope">
        <button
          type="button"
          className={`tap-settings-seg${scope === "near" ? " selected" : ""}`}
          aria-pressed={scope === "near"}
          onClick={() => onScope("near")}
          title="Show tap markers near the playhead only"
        >
          Near
        </button>
        <button
          type="button"
          className={`tap-settings-seg${scope === "all" ? " selected" : ""}`}
          aria-pressed={scope === "all"}
          onClick={() => onScope("all")}
          title="Show every tap marker on this source"
        >
          All
        </button>
      </div>
      <div className="tap-settings-style">
        <button
          type="button"
          className="tap-settings-style-btn"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title="Tap highlight style (applies to the whole edit)"
        >
          <span className="tap-swatch" style={swatch(tapGradient(style, color))} />
          <span className="tap-settings-style-label">{style.label}</span>
          <span className="tap-settings-chevron" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <div className="tap-settings-menu">
            {TAP_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`tap-settings-option${s.id === style.id ? " selected" : ""}`}
                aria-pressed={s.id === style.id}
                onClick={() => {
                  onStyle(s.id);
                  setOpen(false);
                }}
              >
                <span className="tap-swatch" style={swatch(tapGradient(s, color))} />
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tap-settings-colors">
        {TAP_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`tap-settings-color${c.id === color.id ? " selected" : ""}`}
            aria-pressed={c.id === color.id}
            title={c.label}
            style={{ background: `rgb(${c.rgb.join(", ")})` }}
            onClick={() => onColor(c.id)}
          />
        ))}
      </div>
      <label className="tap-settings-size" title={`Tap size (${Math.round(size * 100)}%)`}>
        <span className="tap-settings-size-label">Size</span>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.05}
          value={size}
          onChange={(e) => onSize(Number(e.currentTarget.value))}
          onPointerUp={onSizeCommit}
          onPointerCancel={onSizeCommit}
          onKeyUp={onSizeCommit}
          onBlur={onSizeCommit}
        />
      </label>
    </div>
  );
}

export function EditorApp() {
  // Fade the UI in on first commit (anti-flash reveal).
  useEffect(() => {
    revealApp();
  }, []);

  const [target, setTarget] = useState<EditTarget | null>(null);
  const [doc, setDoc] = useState<EditDoc | null>(null);
  const targetRef = useRef<EditTarget | null>(target);
  const docRef = useRef<EditDoc | null>(doc);
  targetRef.current = target;
  docRef.current = doc;
  const [metas, setMetas] = useState<Record<string, MediaMeta | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [render, setRender] = useState<RenderState>({ phase: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  // The clip context menu reads the playhead at CLICK time (playback keeps moving it while the menu sits open).
  const playheadRef = useRef(playheadMs);
  playheadRef.current = playheadMs;
  const [playing, setPlaying] = useState(false);
  const [trimScrub, setTrimScrub] = useState<TrimScrub | null>(null);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const [armedTap, setArmedTap] = useState(false);
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);
  const [armedMask, setArmedMask] = useState(false);
  const [maskMenu, setMaskMenu] = useState<ContextMenuState | null>(null);
  const [tapMenu, setTapMenu] = useState<ContextMenuState | null>(null);
  const [clipMenu, setClipMenu] = useState<ContextMenuState | null>(null);
  const [tapMarkerScope, setTapMarkerScope] = useState<"near" | "all">("near");

  // ── The reference pane (scene matching): another scene video in output-time lockstep ──
  const [sceneMedia, setSceneMedia] = useState<{ rel: string; label: string }[]>([]);
  const [refView, setRefView] = useState<{ clips: EditClip[]; sources: EditSource[] } | null>(null);
  // A swap in flight: once the new target's doc loads, the old active becomes ITS reference.
  const pendingSwapRef = useRef<{ forName: string; rel: string; offsetMs: number } | null>(null);
  // Alignment aids: the ghost overlay and the sync-mark, both transient (never persisted).
  const [ghost, setGhost] = useState(false);
  const [activeMark, setActiveMark] = useState<number | null>(null);

  // Debounced autosave: rapid mutations coalesce into one save; flushSave() runs any pending write before renders (render_edit reads edit.json from disk) and on close. renderStaleRef backs the warn-on-close (changes not yet in a render).
  const saveTimer = useRef<number | null>(null);
  const pendingDoc = useRef<EditDoc | null>(null);
  const renderStaleRef = useRef(false);

  // Live sync (editLiveSync.ts): the base the next save is checked against, the doc and render-record stamps, and the reasons an outside change waits.
  /** Per edit, so a queued flush for a retargeted edit still saves on the base its previous write left. */
  const basesRef = useRef(new Map<string, EditBase>());
  const baseFor = useCallback(
    (t: { slug: string; name: string }) => basesRef.current.get(`${t.slug}\u0000${t.name}`) ?? null,
    [],
  );
  const setBase = useCallback((t: { slug: string; name: string }, hash: string, doc: EditDoc) => {
    basesRef.current.set(`${t.slug}\u0000${t.name}`, { slug: t.slug, name: t.name, hash, doc });
  }, []);
  /** Saves run one at a time: each checks the base hash the previous one left. */
  const flushChainRef = useRef<Promise<void>>(Promise.resolve());
  const watchRef = useRef<EditWatch>({
    doc: createEditStampState(),
    render: createEditStampState(),
  });
  /** The last render record's doc hash; null = none known. */
  const renderHashRef = useRef<string | null>(null);
  /** The doc vanished or became unreadable: saves wait, the last local doc waits here to merge back. */
  const suspendedRef = useRef(false);
  const detachedRef = useRef<EditDoc | null>(null);
  const resyncWantedRef = useRef(false);
  const savingRef = useRef(false);
  const loadingRef = useRef(false);
  const renderingRef = useRef(false);
  const pointerDownRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const metasRef = useRef(metas);
  metasRef.current = metas;

  const isCurrent = useCallback(
    (t: { slug: string; name: string }) =>
      targetRef.current?.slug === t.slug && targetRef.current?.name === t.name,
    [],
  );

  /** An outside change waits while a gesture, a typed value or a render is in flight. */
  const liveSyncBusy = useCallback(
    (ignoreSaving = false) =>
      pointerDownRef.current ||
      hasPendingTextEdit() ||
      renderingRef.current ||
      loadingRef.current ||
      (!ignoreSaving && savingRef.current),
    [],
  );

  /** Filmstrip metas for sources an outside change added. */
  const ensureMetas = useCallback(
    (t: EditTarget, sources: EditSource[]) => {
      for (const s of sources) {
        if (s.id in metasRef.current) continue;
        mediaMeta(t.slug, s.rel)
          .catch(() => null)
          .then((m) => {
            if (isCurrent(t)) setMetas((prev) => (s.id in prev ? prev : { ...prev, [s.id]: m }));
          });
      }
    },
    [isCurrent],
  );

  /** Take the doc on disk as the new base, merging any unsaved local edits; an outside change becomes ONE "Claude edit" undo step. Returns the doc that still needs saving (it kept local changes), else null. */
  const adoptEntry = useCallback(
    (entry: EditEntry, options: { schedule: boolean }): EditDoc | null => {
      const t = targetRef.current;
      if (!t) return null;
      const base = baseFor(t);
      const local = docRef.current ?? detachedRef.current;
      let next: EditDoc;
      let dropped: string[] = [];
      let keptLocal = false;
      if (base && local) {
        const merged = mergeEditDocs(base.doc, local, entry.doc);
        dropped = merged.dropped;
        keptLocal = merged.keptLocal;
        next = sameValue(merged.doc, local) ? local : merged.doc;
        if (next !== local) pushExternalEditorHistory(local, next);
      } else {
        next = laidOut(entry.doc);
      }
      setBase(t, entry.hash, laidOut(entry.doc));
      resetEditStamp(watchRef.current.doc, entry.stamp);
      detachedRef.current = null;
      suspendedRef.current = false;
      setError(null);
      docRef.current = next;
      setDoc(next);
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      pendingDoc.current = keptLocal ? next : null;
      if (keptLocal && options.schedule) {
        saveTimer.current = window.setTimeout(
          () => void flushSaveRef.current(),
          AUTOSAVE_DEBOUNCE_MS,
        );
      }
      renderHashRef.current = entry.render?.docHash ?? null;
      renderStaleRef.current = keptLocal || renderHashRef.current !== entry.hash;
      const message = describeDropped(dropped);
      if (message) setNotice(message);
      ensureMetas(t, next.sources);
      return keptLocal ? next : null;
    },
    [baseFor, setBase, ensureMetas],
  );

  /** The doc on disk is gone or unreadable: show the error panel and hold saves; the local doc merges back if it returns. */
  const detach = useCallback((message: string, removed: boolean) => {
    if (docRef.current) detachedRef.current = docRef.current;
    suspendedRef.current = true;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    docRef.current = null;
    setDoc(null);
    setError(message);
    if (removed) renderStaleRef.current = false;
  }, []);

  /** Our own write landed: it is the new base, and its stamp never reads as an outside change. */
  const noteSaved = useCallback(
    (t: EditTarget, saved: EditDoc, write: EditWrite) => {
      setBase(t, write.hash, saved);
      if (!isCurrent(t)) return;
      adoptOwnWrite(watchRef.current.doc, write);
      if (pendingDoc.current === null) {
        renderStaleRef.current = renderHashRef.current !== write.hash;
      }
    },
    [isCurrent, setBase],
  );

  /** One save against the edit's base hash; a conflict re-reads, merges and saves once more. A retargeted (old) edit merges without touching the UI. */
  const saveNow = useCallback(
    async (t: EditTarget, pending: EditDoc) => {
      const own = baseFor(t);
      savingRef.current = true;
      let latest = pending;
      try {
        const outcome = await saveWithRebase(EDIT_IO, t, pending, own?.hash ?? null, (entry) => {
          // A retargeted (or reloading) edit merges on its own base and never touches the UI.
          if (!isCurrent(t) || loadingRef.current) {
            if (!own) return null;
            const merged = mergeEditDocs(own.doc, pending, entry.doc);
            return merged.keptLocal ? merged.doc : null;
          }
          if (liveSyncBusy(true)) return "defer";
          const merged = adoptEntryRef.current(entry, { schedule: false });
          pendingDoc.current = null;
          if (merged) latest = merged;
          return merged;
        });
        if (outcome.kind === "deferred") {
          if (isCurrent(t)) {
            pendingDoc.current ??= outcome.doc;
            resyncWantedRef.current = true;
          }
        } else if (outcome.kind === "saved") {
          noteSaved(t, outcome.doc, outcome.write);
        }
      } catch (e) {
        if (isCurrent(t) && pendingDoc.current === null) pendingDoc.current = latest;
        setSaveError(`Autosave failed: ${String(e)}`);
      } finally {
        savingRef.current = false;
      }
    },
    [baseFor, isCurrent, liveSyncBusy, noteSaved],
  );

  /** Takes the pending doc now (so a retarget can't swap it), saves it after any save in flight; resolves once everything queued has landed. */
  const flushSave = useCallback((): Promise<void> => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingDoc.current;
    const t = targetRef.current;
    if (!pending || !t || suspendedRef.current) return flushChainRef.current;
    pendingDoc.current = null;
    const run = flushChainRef.current.then(() => saveNow(t, pending));
    flushChainRef.current = run;
    return run;
  }, [saveNow]);
  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;
  const adoptEntryRef = useRef(adoptEntry);
  adoptEntryRef.current = adoptEntry;

  // Load the edit for a target (boot + when the main window points us at a different one).
  const load = useCallback(
    (t: EditTarget) => {
      // Never lose a pending save from the previous target: it reads its own base before anything resets, and the read below waits for it.
      const flushed = flushSaveRef.current();
      bindEditorHistory(t.slug, t.name);
      renderStaleRef.current = false;
      targetRef.current = t;
      docRef.current = null;
      pendingDoc.current = null;
      detachedRef.current = null;
      suspendedRef.current = false;
      resyncWantedRef.current = false;
      renderHashRef.current = null;
      watchRef.current = { doc: createEditStampState(), render: createEditStampState() };
      loadingRef.current = true;
      setTarget(t);
      setDoc(null);
      setMetas({});
      setError(null);
      setSaveError(null);
      setNotice(null);
      setRender({ phase: "idle" });
      setSelectedId(null);
      setSelectedMaskId(null);
      setArmedMask(false);
      setPlayheadMs(0);
      setPlaying(false);
      const isCurrentTarget = () =>
        targetRef.current?.slug === t.slug && targetRef.current?.name === t.name;
      flushed
        .then(() => loadEditEntry(t.slug, t.name))
        .then((entry) => {
          if (!isCurrentTarget()) return;
          loadingRef.current = false;
          const d = entry.doc;
          // Normalise on load: the timeline is magnetic, startMs is derived state.
          const loaded = laidOut(d);
          setBase(t, entry.hash, loaded);
          resetEditStamp(watchRef.current.doc, entry.stamp);
          renderHashRef.current = entry.render?.docHash ?? null;
          renderStaleRef.current = entry.render !== null && entry.render.docHash !== entry.hash;
          const next = { ...loaded };
          // A completed swap: the previous active becomes this doc's reference, offset negated, saved on the normal debounce.
          const swap = pendingSwapRef.current;
          if (swap && swap.forName === t.name) {
            pendingSwapRef.current = null;
            next.reference = { rel: swap.rel, offsetMs: swap.offsetMs };
            pushEditorHistory({ label: "swap reference", before: loaded, after: next });
            renderStaleRef.current = true;
            pendingDoc.current = next;
            if (saveTimer.current !== null) clearTimeout(saveTimer.current);
            saveTimer.current = window.setTimeout(
              () => void flushSaveRef.current(),
              AUTOSAVE_DEBOUNCE_MS,
            );
          }
          docRef.current = next;
          setDoc(next);
          // Filmstrips ride the scrub cache (warm for anything the library has shown).
          Promise.all(
            d.sources.map((s) =>
              mediaMeta(t.slug, s.rel)
                .then((m) => [s.id, m] as const)
                .catch(() => [s.id, null] as const),
            ),
          ).then((entries) => {
            if (isCurrentTarget())
              setMetas((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
          });
        })
        .catch((e) => {
          if (!isCurrentTarget()) return;
          loadingRef.current = false;
          setError(String(e));
        });
    },
    [setBase],
  );

  // Live sync: poll the doc and render-record stamps; a settled outside change merges in as one undo step, a removed or unreadable doc shows the error panel until a later poll reads it fine.
  useEffect(() => {
    const t = target;
    if (!t) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight || liveSyncBusy()) return;
      inFlight = true;
      try {
        const outcome = await pollEdit(EDIT_IO, t, watchRef.current, resyncWantedRef.current);
        if (cancelled || !isCurrent(t)) return;
        if (outcome.kind === "removed") {
          resyncWantedRef.current = false;
          detach(`edits/${t.name}.json was removed outside the editor.`, true);
        } else if (outcome.kind === "unreadable") {
          resyncWantedRef.current = false;
          detach(outcome.error, false);
        } else if (outcome.kind === "changed") {
          if (liveSyncBusy()) {
            resyncWantedRef.current = true;
            return;
          }
          resyncWantedRef.current = false;
          adoptEntry(outcome.entry, { schedule: true });
        } else if (outcome.kind === "render") {
          renderHashRef.current = outcome.render?.docHash ?? null;
          const base = baseFor(t);
          if (base) {
            renderStaleRef.current =
              pendingDoc.current !== null || renderHashRef.current !== base.hash;
          }
        }
      } catch (e) {
        console.warn("[editor] live sync poll failed:", e);
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void tick(), LIVE_POLL_MS);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [target, isCurrent, liveSyncBusy, detach, adoptEntry, baseFor]);

  // A pointer held down is a gesture in progress: outside changes wait for it to end.
  useEffect(() => {
    const down = () => {
      pointerDownRef.current = true;
    };
    const up = () => {
      pointerDownRef.current = false;
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
    };
  }, []);

  // Boot: read the pending target the main window stashed before opening us.
  useEffect(() => {
    getEditorTarget()
      .then((t) => {
        if (t) load(t);
        else
          setError("No edit is open. Pick a video or image in the media library and choose Edit.");
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

  // Finder drops: this window disables Tauri's native drag-drop handler (the timeline's HTML5 drag needs the events), so OS drops arrive as HTML5 File objects, bytes without paths. Import SEQUENTIALLY: the free-name collision check reads the disk, so parallel same-stem imports would race. The media-changed broadcast refreshes the panel here and every main-window picker.
  const [dropError, setDropError] = useState<string | null>(null);
  useEffect(() => {
    const slug = target?.slug;
    if (!slug) return;
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      void (async () => {
        try {
          for (const file of Array.from(files)) {
            await importMediaBytes(slug, file.name, new Uint8Array(await file.arrayBuffer()));
          }
        } catch (err) {
          setDropError(`Import failed: ${String(err)}`);
        }
      })();
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [target?.slug]);

  /** Commit a document mutation through the editor's state, stale-render and autosave funnel. */
  const commitDoc = useCallback(
    (draft: EditDoc, label: string, options: { record?: boolean; coalesceKey?: string } = {}) => {
      // A mask no clip shows any more goes with the edit that orphaned it (undo restores both).
      const masks = draft.masks && pruneOrphanMasks(draft.clips, draft.masks, draft.sources);
      const next = masks === draft.masks ? draft : { ...draft, masks };
      const before = docRef.current;
      if (options.record !== false && before) {
        pushEditorHistory({ label, before, after: next, coalesceKey: options.coalesceKey });
      }
      docRef.current = next;
      setDoc(next);
      renderStaleRef.current = true;
      pendingDoc.current = next;
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(
        () => void flushSaveRef.current(),
        AUTOSAVE_DEBOUNCE_MS,
      );
    },
    [],
  );

  /** Apply one shared edit op (editOps.ts, the spec kb video mirrors) to the current doc and commit it; a refused op changes nothing. */
  const runOp = useCallback(
    (op: EditOp, options: { label?: string; coalesceKey?: string } = {}): EditOpResult | null => {
      const current = docRef.current;
      if (!current || !targetRef.current) return null;
      const result = applyEditOp(current, op);
      if (result.ok) {
        commitDoc(result.doc, options.label ?? result.label, { coalesceKey: options.coalesceKey });
      }
      return result;
    },
    [commitDoc],
  );

  // Focused native Edit-menu events land in this window only. Replays use commitDoc without recording.
  useEffect(() => {
    const run = (direction: "undo" | "redo") => {
      if (hasPendingTextEdit()) {
        document.execCommand(direction);
        return;
      }
      if (render.phase === "rendering" || !docRef.current) return;
      const entry = direction === "undo" ? takeEditorUndo() : takeEditorRedo();
      if (!entry) return;
      const snapshot = direction === "undo" ? entry.before : entry.after;
      commitDoc({ ...snapshot, clips: relayout(snapshot.clips) }, entry.label, { record: false });
    };
    const undo = listen("kookaburra://undo", () => run("undo"));
    const redo = listen("kookaburra://redo", () => run("redo"));
    return () => {
      void undo.then((unlisten) => unlisten());
      void redo.then((unlisten) => unlisten());
    };
  }, [render.phase, commitDoc]);

  // The scene's other videos, labelled for the Compare dropdown; scene-scoped by design, read from the sidecar so it can't go stale against a passed-in list.
  useEffect(() => {
    void mediaRefresh; // re-read after imports and cache clears
    const t = target;
    if (!t || t.sceneIndex === undefined) {
      setSceneMedia([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const manifest = JSON.parse(await readProjectManifestSnapshot(t.slug)) as {
          scenes?: { file?: string }[];
        };
        const file = manifest.scenes?.[t.sceneIndex ?? -1]?.file;
        if (!file) return;
        const text = await invoke<string | null>("read_scene_doc", {
          slug: t.slug,
          file: file.replace(/\.tsx$/, ".json"),
        });
        const sceneDoc = text ? parseSceneDoc(JSON.parse(text), `${t.slug}/${file}`) : undefined;
        if (!sceneDoc || cancelled) return;
        const entries: { rel: string; label: string }[] = [];
        const devices = sceneDoc.devices ?? [];
        // A foldable's outside display lists beside its inside one; single-screen labels are unchanged.
        const screenLabel = (slot: DeviceScreenSlot) =>
          slot === "cover" ? " · Outside screen" : "";
        devices.forEach((d, i) => {
          for (const slot of DEVICE_SCREEN_SLOTS) {
            const media = deviceSlotMedia(d, slot);
            if (media?.kind !== "video") continue;
            const model = resolveAvailableDeviceSpec(d.model).name;
            entries.push({
              rel: media.src,
              label: `Device ${i + 1} · ${model}${screenLabel(slot)}`,
            });
          }
        });
        for (const slot of DEVICE_SCREEN_SLOTS) {
          const overrides =
            slot === "cover" ? sceneDoc.compare?.b?.coverMedia : sceneDoc.compare?.b?.media;
          for (const [id, m] of Object.entries(overrides ?? {})) {
            if (m.kind !== "video") continue;
            const i = devices.findIndex((d) => d.id === id);
            entries.push({
              rel: m.src,
              label: `After side · Device ${i >= 0 ? i + 1 : id}${screenLabel(slot)}`,
            });
          }
        }
        for (const entry of resolveSceneDocMedia(sceneDoc)) {
          if (entry.kind !== "video") continue;
          entries.push({ rel: entry.src, label: entry.window ? "Video window" : "Video" });
        }
        if (sceneDoc.background?.type === "video") {
          entries.push({ rel: sceneDoc.background.src, label: "Background" });
        }
        const own = new Set([t.sourceRel, `assets/${t.name}-edited.mp4`]);
        const seen = new Set<string>();
        const list = entries.filter((e) => {
          if (own.has(e.rel) || seen.has(e.rel)) return false;
          seen.add(e.rel);
          return true;
        });
        if (!cancelled) setSceneMedia(list);
      } catch (e) {
        console.warn("[editor] scene media inventory failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, mediaRefresh]);

  // Resolve the reference to playable clips: its edit doc when one exists (matched by rendered-output rel or source rel, Michael's output-time-lockstep call), else the raw file as one full-length clip. A missing file drops the pane, never the stored pairing.
  const refRel = doc?.reference?.rel ?? null;
  useEffect(() => {
    void mediaRefresh; // a re-render of the reference's own edit re-resolves it
    const slug = target?.slug;
    if (!slug || !refRel) {
      setRefView(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const names = await listEdits(slug);
        const m = /^assets\/(.+)-edited\.mp4$/.exec(refRel);
        let matched: EditDoc | null = null;
        if (m && names.includes(m[1])) {
          matched = await loadEdit(slug, m[1]);
        } else {
          for (const name of names) {
            const candidate = await loadEdit(slug, name).catch(() => null);
            if (candidate?.sources[0]?.rel === refRel) {
              matched = candidate;
              break;
            }
          }
        }
        if (cancelled) return;
        if (matched) {
          setRefView({ clips: relayout(matched.clips), sources: matched.sources });
          return;
        }
        const meta = await mediaMeta(slug, refRel);
        if (cancelled) return;
        if (meta.kind !== "video") {
          setRefView(null);
          return;
        }
        setRefView({
          sources: [
            {
              id: "r1",
              rel: refRel,
              kind: "video",
              width: meta.width,
              height: meta.height,
              fps: meta.fps,
              durationMs: meta.durationMs,
            },
          ],
          clips: [
            { id: "rc1", sourceId: "r1", inMs: 0, outMs: meta.durationMs, speed: 1, startMs: 0 },
          ],
        });
      } catch (e) {
        console.warn("[editor] reference resolve failed:", e);
        if (!cancelled) setRefView(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target?.slug, refRel, mediaRefresh]);

  // A different reference (or none) starts the aids clean.
  useEffect(() => {
    void refRel; // the reset keys off the pairing, not any read of it
    setGhost(false);
    setActiveMark(null);
  }, [refRel]);

  // ── Alignment aids: frame nudge, bake-as-trim, sync markers (03-editor-uplift.md) ──
  const refFps = refView?.sources[0]?.fps ?? 0;
  const refFrameMs = 1000 / (refFps > 0 ? refFps : 60);
  /** Slide the reference by whole frames; provisional (pane + strip only) until baked. */
  const nudgeReference = (frames: number) => {
    if (!doc?.reference) return;
    commitDoc(
      {
        ...doc,
        reference: {
          ...doc.reference,
          offsetMs: Math.round(doc.reference.offsetMs + frames * refFrameMs),
        },
      },
      "nudge reference",
    );
  };
  const firstClip = doc?.clips[0];
  const canBake =
    !!doc?.reference && doc.reference.offsetMs > 0 && !!firstClip && firstClip.holdMs === undefined;
  /** Apply a found positive offset to the ACTIVE clip's in-point (the reference is read-only by contract) and zero the offset. Negative offsets stay stored: a magnetic timeline has no blank lead to add. */
  const bakeAsTrim = () => {
    if (!doc?.reference || !canBake || !firstClip) return;
    const speed = firstClip.speed > 0 ? firstClip.speed : 1;
    const delta = doc.reference.offsetMs * speed;
    const maxTrim = Math.max(0, firstClip.outMs - firstClip.inMs - refFrameMs);
    const inMs = Math.round(firstClip.inMs + Math.min(delta, maxTrim));
    const clips = relayout(doc.clips.map((c, i) => (i === 0 ? { ...c, inMs } : c)));
    commitDoc(
      { ...doc, clips, reference: { ...doc.reference, offsetMs: 0 } },
      "bake reference alignment",
    );
  };
  /** Sync markers: Mark stores the beat's time on the active video; scrub until the reference pane shows the same beat, Match sets the offset from the difference. */
  const matchReference = () => {
    if (!doc?.reference || activeMark === null) return;
    const refBeatMs = playheadMs + doc.reference.offsetMs;
    commitDoc(
      {
        ...doc,
        reference: { ...doc.reference, offsetMs: Math.round(refBeatMs - activeMark) },
      },
      "match reference",
    );
    setActiveMark(null);
  };

  /** Swap: open the reference's edit as the active document; the current one becomes ITS reference with the offset negated (applied when the new doc loads). */
  const swapReference = useCallback(async () => {
    if (!doc?.reference || !target) return;
    const { rel, offsetMs } = doc.reference;
    await flushSaveRef.current();
    try {
      const names = await listEdits(target.slug);
      const m = /^assets\/(.+)-edited\.mp4$/.exec(rel);
      const name =
        m && names.includes(m[1])
          ? await openEditNamed(target.slug, m[1], target.sceneIndex)
          : await openEdit(target.slug, rel, target.sceneIndex);
      pendingSwapRef.current = { forName: name, rel: target.sourceRel, offsetMs: -offsetMs };
    } catch (e) {
      setSaveError(`Couldn't swap to the reference: ${String(e)}`);
    }
  }, [doc, target]);

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
      "Discard this edit and start over from the source file? The current document is kept beside it as a .json.bak backup.",
      { title: "Discard edit", kind: "warning" },
    );
    if (!sure) return;
    resetEdit(target.slug, target.name, target.sourceRel)
      .then(() => {
        bindEditorHistory(null, null);
        load(target);
      })
      .catch((e) => setError(String(e)));
  }, [target, load]);

  // Keep selection and playhead valid as clips change (delete, trim, reorder).
  useEffect(() => {
    if (!doc) return;
    if (selectedId && !doc.clips.some((c) => c.id === selectedId)) setSelectedId(null);
    if (selectedMaskId && !doc.masks?.some((m) => m.id === selectedMaskId)) {
      setSelectedMaskId(null);
    }
    const durationMs = timelineDurationMs(doc.clips);
    setPlayheadMs((p) => Math.min(p, durationMs));
  }, [doc, selectedId, selectedMaskId]);

  /** One selection at a time: picking a clip clears the mask and the reverse; clearing either (an empty-track click) clears both. */
  const selectClip = useCallback((id: string | null) => {
    setSelectedId(id);
    setSelectedMaskId(null);
  }, []);
  const selectMask = useCallback((id: string | null) => {
    setSelectedMaskId(id);
    if (id) setSelectedId(null);
  }, []);

  /** Spacebar transport: toggle playback (restarts from 0 when parked at the end, or anywhere off a clip; `clipIndexAt` is the same check the rAF loop uses to stop). */
  const togglePlay = useCallback(() => {
    if (!doc || doc.clips.length === 0) return;
    if (
      !playing &&
      (clipIndexAt(doc.clips, playheadMs) < 0 || playheadMs >= timelineDurationMs(doc.clips) - 1)
    ) {
      setPlayheadMs(0);
    }
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

  const handleRender = useCallback(async () => {
    const t = targetRef.current;
    if (!t || !docRef.current) return;
    setRender({ phase: "rendering", frame: 0, total: 1 });
    try {
      await flushSave(); // render_edit reads edit.json from disk, so persist the latest doc first
      renderingRef.current = true;
      const result = await renderEdit(t.slug, t.name, (p: RenderProgress) =>
        setRender({ phase: "rendering", frame: p.frame, total: p.total }),
      );
      renderingRef.current = false;
      renderHashRef.current = result.docHash;
      const stamps = await editStamps(t.slug, t.name).catch(() => null);
      const base = baseFor(t);
      const changed =
        !base ||
        result.docHash !== base.hash ||
        pendingDoc.current !== null ||
        (stamps !== null && stamps.doc !== watchRef.current.doc.baseline);
      // The output changed either way: tell the main window (media library refresh, re-point).
      await emit("kookaburra://media-changed", { slug: t.slug, name: t.name });
      if (changed) {
        renderStaleRef.current = true;
        setRender({ phase: "changed" });
        return;
      }
      renderStaleRef.current = false;
      await getCurrentWindow().close();
    } catch (e) {
      setRender({ phase: "error", message: String(e) });
    } finally {
      renderingRef.current = false;
    }
  }, [flushSave, baseFor]);

  /** Shared add/insert flow: probe `rel` (which also warms the filmstrip cache), then the addClip or insertClip op reuses or creates its source and builds the clip. */
  const spliceClip = useCallback(
    (rel: string, opFor: (source: SourceMeta) => EditOp) => {
      const requestedTarget = targetRef.current;
      if (!docRef.current || !requestedTarget) return;
      mediaMeta(requestedTarget.slug, rel)
        .then((meta) => {
          if (!isCurrent(requestedTarget)) return;
          const result = runOp(
            opFor({
              rel,
              kind: meta.kind,
              width: meta.width,
              height: meta.height,
              fps: meta.fps,
              durationMs: meta.durationMs,
            }),
          );
          const sourceId = result?.ok
            ? result.doc.sources.find((s) => s.rel === rel)?.id
            : undefined;
          if (sourceId) setMetas((prev) => ({ ...prev, [sourceId]: meta }));
        })
        .catch((e) => setSaveError(`Couldn't add the clip: ${String(e)}`));
    },
    [isCurrent, runOp],
  );

  /** Insert a full-length clip of `rel` at clip position `index` (end when omitted). */
  const handleAddClip = useCallback(
    (rel: string, index?: number) =>
      spliceClip(rel, (source) => ({ op: "addClip", source, index })),
    [spliceClip],
  );

  /** Splice a full-length clip of `rel` in at output time `tMs`; mid-clip splits the clip under it (the freeze-frame pattern). */
  const handleInsertClipAt = useCallback(
    (rel: string, tMs: number) =>
      spliceClip(rel, (source) => ({ op: "insertClip", source, atMs: tMs })),
    [spliceClip],
  );

  const handleSplit = useCallback(() => {
    runOp({ op: "split", atMs: playheadRef.current });
  }, [runOp]);

  /** Freeze the frame under the playhead for a default beat; the Hold field retimes it. */
  const handleFreeze = useCallback(() => {
    runOp({ op: "freeze", atMs: playheadRef.current });
  }, [runOp]);

  const handleRemoveClip = useCallback(
    (clipId: string) => {
      runOp({ op: "removeClip", clipId });
    },
    [runOp],
  );

  const handlePlaceTap = useCallback(
    (pos: [number, number]) => {
      runOp({ op: "addTap", atMs: playheadRef.current, pos });
    },
    [runOp],
  );

  const handleCommitTap = useCallback(
    (tapId: string, pos: [number, number]) => {
      runOp({ op: "moveTap", tapId, pos });
    },
    [runOp],
  );

  const handleTapStyle = useCallback(
    (style: string) => {
      runOp({ op: "setTapLook", style });
    },
    [runOp],
  );

  const handleTapColor = useCallback(
    (color: string) => {
      runOp({ op: "setTapLook", color });
    },
    [runOp],
  );

  const handleTapSize = useCallback(
    (size: number) => {
      runOp({ op: "setTapLook", size }, { coalesceKey: "tap-size" });
    },
    [runOp],
  );

  /** Commit one mask's edit directly (the lane diamond's delete, which names a key by source time). */
  const commitMask = useCallback(
    (mask: EditMask, label: string) => {
      const current = docRef.current;
      if (!current) return;
      commitDoc({ ...current, masks: replaceMask(current.masks ?? [], mask) }, label);
    },
    [commitDoc],
  );

  /** The frame on screen for mask edits, with the key tolerance at its clip's speed. */
  const maskMomentAt = useCallback(
    (ms: number): { moment: SourceMoment; tolMs: number; image: boolean } | null => {
      const current = docRef.current;
      if (!current) return null;
      const moment = sourceMomentAt(current.clips, ms);
      if (!moment) return null;
      const source = current.sources.find((s) => s.id === moment.sourceId);
      const fps = current.settings.fps > 0 ? current.settings.fps : 60;
      return {
        moment,
        tolMs: keyToleranceMs(fps, moment.hold ? 1 : moment.clip.speed),
        image: source?.kind === "image",
      };
    },
    [],
  );

  /** A new box: solid black (Michael's default) over the next 3 s of what's on screen, keyed at this frame, then selected. */
  const handleDrawMask = useCallback(
    (rect: MaskRect) => {
      const result = runOp({ op: "addMask", atMs: playheadRef.current, rect });
      if (!result?.ok || !result.created) return;
      setArmedMask(false);
      selectMask(result.created);
    },
    [runOp, selectMask],
  );

  /** Auto-key: a move or resize records the box at the frame on screen. */
  const handleCommitMaskRect = useCallback(
    (maskId: string, rect: MaskRect, kind: "move" | "resize") => {
      runOp(
        { op: "setMaskRect", maskId, atMs: playheadRef.current, rect },
        { label: kind === "move" ? "move mask" : "resize mask" },
      );
    },
    [runOp],
  );

  const handleCommitMaskPath = useCallback(
    (maskId: string, dx: number, dy: number) => {
      runOp({ op: "offsetMask", maskId, dx, dy });
    },
    [runOp],
  );

  /** Pin the current glide at the playhead so later drags only reshape what follows. */
  const handleAddMaskKey = useCallback(
    (maskId: string) => {
      runOp({ op: "addMaskKey", maskId, atMs: playheadRef.current });
    },
    [runOp],
  );

  const handleRemoveMaskKey = useCallback(
    (maskId: string) => {
      runOp({ op: "removeMaskKey", maskId, atMs: playheadRef.current });
    },
    [runOp],
  );

  const handleDeleteMask = useCallback(
    (maskId: string) => {
      runOp({ op: "removeMask", maskId });
    },
    [runOp],
  );

  /** Where a mask's key sits relative to the playhead: on one, or none here (and why not). */
  const maskKeyState = useCallback(
    (mask: EditMask): { onKey: boolean; editable: boolean } => {
      const at = maskMomentAt(playheadRef.current);
      if (!at || at.moment.sourceId !== mask.sourceId) return { onKey: false, editable: false };
      if (at.image) return { onKey: true, editable: false };
      const inSpan = at.moment.sourceMs >= mask.startMs && at.moment.sourceMs < mask.endMs;
      return { onKey: keyIndexAt(mask.keys, at.moment.sourceMs, at.tolMs) >= 0, editable: inSpan };
    },
    [maskMomentAt],
  );

  const handleMaskContextMenu = useCallback(
    (id: string, x: number, y: number) => {
      const mask = docRef.current?.masks?.find((m) => m.id === id);
      if (!mask) return;
      const { onKey, editable } = maskKeyState(mask);
      setMaskMenu({
        x,
        y,
        items: [
          {
            id: "add-key",
            label: "Add key here",
            disabled: !editable || onKey,
            title: onKey ? "A key already sits at this frame" : undefined,
            onSelect: () => handleAddMaskKey(id),
          },
          {
            id: "delete-key",
            label: "Delete key here",
            disabled: !editable || !onKey || mask.keys.length <= 1,
            title: mask.keys.length <= 1 ? "A mask keeps at least one key" : undefined,
            onSelect: () => handleRemoveMaskKey(id),
          },
          {
            id: "delete",
            label: "Delete mask",
            confirmLabel: "Really delete?",
            danger: true,
            onSelect: () => handleDeleteMask(id),
          },
        ],
      });
    },
    [maskKeyState, handleAddMaskKey, handleRemoveMaskKey, handleDeleteMask],
  );

  const handleMaskStyle = useCallback(
    (maskId: string, style: EditMaskStyle) => {
      runOp({ op: "setMaskLook", maskId, style });
    },
    [runOp],
  );

  const handleMaskStrength = useCallback(
    (maskId: string, strength: number) => {
      runOp({ op: "setMaskLook", maskId, strength }, { coalesceKey: `mask-strength:${maskId}` });
    },
    [runOp],
  );

  const handleMaskColor = useCallback(
    (maskId: string, color: string | undefined) => {
      runOp({ op: "setMaskLook", maskId, color: color ?? null });
    },
    [runOp],
  );

  /** Right-click on a lane key diamond: delete exactly that key (a mask keeps its last one). */
  const handleMaskKeyMenu = useCallback(
    (id: string, sourceMs: number, x: number, y: number) => {
      const mask = docRef.current?.masks?.find((m) => m.id === id);
      if (!mask) return;
      setMaskMenu({
        x,
        y,
        items: [
          {
            id: "delete-key",
            label: "Delete key",
            disabled: mask.keys.length <= 1,
            title: mask.keys.length <= 1 ? "A mask keeps at least one key" : undefined,
            onSelect: () => commitMask(removeMaskKey(mask, sourceMs, 0.5), "delete mask key"),
          },
        ],
      });
    },
    [commitMask],
  );

  /** A mask drag pauses playback, so the key lands on the frame you grabbed. */
  const handleMaskGesture = useCallback(() => setPlaying(false), []);

  const firstSource = doc?.sources[0] ?? null;
  const selectedClip = doc?.clips.find((c) => c.id === selectedId) ?? null;
  const totalMs = doc ? timelineDurationMs(doc.clips) : 0;
  const canSplit = doc ? splitAt(doc.clips, playheadMs, "probe") !== null : false;
  const outputFps = doc && doc.settings.fps > 0 ? doc.settings.fps : 60;
  const atTimelineEnd = Math.abs(playheadMs - totalMs) <= 500 / outputFps;
  const canFreeze = doc
    ? atTimelineEnd
      ? freezeAtEnd(doc.clips, outputFps, DEFAULT_HOLD_MS) !== null
      : freezeAt(doc.clips, playheadMs, DEFAULT_HOLD_MS) !== null
    : false;
  const canTap = doc ? outputToSource(doc.clips, playheadMs) !== null : false;
  const canMask = doc ? sourceMomentAt(doc.clips, playheadMs) !== null : false;
  const selectedMask = doc?.masks?.find((m) => m.id === selectedMaskId) ?? null;
  const selectedMaskImage =
    !!selectedMask && doc?.sources.find((s) => s.id === selectedMask.sourceId)?.kind === "image";
  // The strip's owner: an armed tap tool, then the mask tool or a selected mask, then taps. With masks but no taps the mask strip stays mounted, so drawing never shifts the preview mid-gesture.
  const maskStrip =
    !armedTap &&
    (armedMask ||
      !!selectedMask ||
      ((doc?.masks?.length ?? 0) > 0 && (doc?.taps?.length ?? 0) === 0));

  /** Every tap's visible output windows, flattened for the preview glow and the ruler markers. */
  const tapWindowList = useMemo(
    () =>
      (doc?.taps ?? []).flatMap((tap) =>
        tapWindows(doc?.clips ?? [], tap, TAP_ANIMATION_DURATION_MS).map((w) => ({ tap, ...w })),
      ),
    [doc],
  );

  const handleTapContextMenu = useCallback(
    (tapId: string, x: number, y: number) => {
      // The playhead when the menu opened, as before: playback may move it while the menu is up.
      const atMs = playheadRef.current;
      setTapMenu({
        x,
        y,
        items: [
          {
            id: "retime",
            label: "Move to playhead",
            disabled: !canTap,
            title: canTap ? undefined : "The playhead isn't on a placeable moment",
            onSelect: () => {
              runOp({ op: "retimeTap", tapId, atMs });
            },
          },
          {
            id: "delete",
            label: "Delete",
            confirmLabel: "Really delete?",
            danger: true,
            onSelect: () => {
              runOp({ op: "removeTap", tapId });
            },
          },
        ],
      });
    },
    [canTap, runOp],
  );

  /** Right-click menu on a timeline clip (the tap-marker menu's pattern). */
  const handleClipContextMenu = useCallback(
    (id: string, x: number, y: number) => {
      const clip = doc?.clips.find((c) => c.id === id);
      const rel = clip ? doc?.sources.find((s) => s.id === clip.sourceId)?.rel : undefined;
      setClipMenu({
        x,
        y,
        items: [
          {
            id: "insert",
            label: "Insert at playhead",
            disabled: !rel,
            title: "Splice this clip's media in at the playhead, full length",
            onSelect: () => {
              if (rel) handleInsertClipAt(rel, playheadRef.current);
            },
          },
          {
            id: "append",
            label: "Append to the end",
            disabled: !rel,
            title: "Add this clip's media again as the last clip",
            onSelect: () => {
              if (rel) handleAddClip(rel);
            },
          },
          {
            id: "remove",
            label: "Remove clip",
            confirmLabel: "Really remove?",
            danger: true,
            onSelect: () => {
              handleRemoveClip(id);
            },
          },
        ],
      });
    },
    [doc, handleInsertClipAt, handleAddClip, handleRemoveClip],
  );

  // Space plays/pauses (committing the value first when it comes from the tap-size slider or the hold field, where a literal space means nothing); S/F split/freeze at the playhead; Delete/Backspace removes the selected clip; Escape deselects. Lives below canSplit/canFreeze so the dependency array can read them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const formControl = !!t && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName);
      if (formControl && !(e.key === " " && spaceMeansPlayback(t))) return;
      // The media panel has its own keyboard semantics, and an open fullscreen preview owns the transport keys (its VideoPlayer handles them).
      if (t?.closest(".editor-media-panel")) return;
      if (document.querySelector(".media-preview")) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === " ") {
        e.preventDefault();
        if (formControl) t?.blur(); // Enter semantics: the field's own onBlur commits before playback starts
        togglePlay();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const direction = e.key === "ArrowLeft" ? -1 : 1;
        stepFrames(direction * (e.shiftKey ? 10 : 1));
      } else if (plain && e.key.toLowerCase() === "s" && canSplit) {
        e.preventDefault();
        handleSplit();
      } else if (plain && e.key.toLowerCase() === "f" && canFreeze) {
        e.preventDefault();
        handleFreeze();
      } else if (plain && e.key.toLowerCase() === "t" && (armedTap || canTap)) {
        e.preventDefault();
        setArmedTap((a) => !a);
        setArmedMask(false);
      } else if (plain && e.key.toLowerCase() === "m" && (armedMask || canMask)) {
        e.preventDefault();
        setArmedMask((a) => !a);
        setArmedTap(false);
      } else if ((e.key === "Delete" || e.key === "Backspace") && doc && selectedMaskId) {
        e.preventDefault();
        handleDeleteMask(selectedMaskId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && doc && selectedId) {
        e.preventDefault();
        handleRemoveClip(selectedId);
      } else if (e.key === "Escape") {
        // Disarm a tool first, deselect only when none was armed (the AnimationLane pattern).
        if (armedMask) setArmedMask(false);
        else if (armedTap) setArmedTap(false);
        else if (selectedMaskId) setSelectedMaskId(null);
        else setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    doc,
    selectedId,
    handleRemoveClip,
    togglePlay,
    stepFrames,
    handleSplit,
    handleFreeze,
    canSplit,
    canFreeze,
    armedTap,
    canTap,
    armedMask,
    canMask,
    selectedMaskId,
    handleDeleteMask,
  ]);

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
        {/* The shared MediaBrowser as a persistent side panel: same cards as the main window's Media modal; videos and images drag into the timeline (this window disables Tauri's native drag-drop handler to free HTML5 DnD). */}
        <aside className="editor-media-panel" aria-label="Project media">
          {target && (
            <MediaBrowser
              slug={target.slug}
              projectPath={target.path}
              refreshKey={mediaRefresh}
              compact
              draggableMedia
              kindToggle
              hint="Drag into the timeline"
              cardMenu={mediaCardMenu({
                slug: target.slug,
                primaryLabel: "Insert",
                onPrimary: (rel) => handleAddClip(rel),
                onChanged: () => setMediaRefresh((n) => n + 1),
                onError: setSaveError,
                // This edit's own source and rendered output are already open here: claim Edit as a no-op.
                onEdit: (rel) =>
                  rel === target.sourceRel || rel === `assets/${target.name}-edited.mp4`,
              })}
            />
          )}
        </aside>
        <div className="editor-stage-col">
          <main className="editor-stage" ref={stageRef}>
            {doc && maskStrip ? (
              <div className="editor-tap-bar">
                <MaskSettingsBar
                  mask={selectedMask}
                  image={selectedMaskImage}
                  keyState={
                    selectedMask ? maskKeyState(selectedMask) : { onKey: false, editable: false }
                  }
                  onStyle={(style) => selectedMask && handleMaskStyle(selectedMask.id, style)}
                  onStrength={(v) => selectedMask && handleMaskStrength(selectedMask.id, v)}
                  onStrengthCommit={closeEditorHistoryCoalescing}
                  onColor={(hex) => selectedMask && handleMaskColor(selectedMask.id, hex)}
                  onAddKey={() => selectedMask && handleAddMaskKey(selectedMask.id)}
                  onRemoveKey={() => selectedMask && handleRemoveMaskKey(selectedMask.id)}
                  onDelete={() => selectedMask && handleDeleteMask(selectedMask.id)}
                />
              </div>
            ) : (
              doc &&
              ((doc.taps?.length ?? 0) > 0 || armedTap || (doc.masks?.length ?? 0) > 0) && (
                <div className="editor-tap-bar">
                  <TapSettingsBar
                    scope={tapMarkerScope}
                    onScope={setTapMarkerScope}
                    styleId={doc.tapStyle ?? DEFAULT_TAP_STYLE_ID}
                    onStyle={handleTapStyle}
                    colorId={doc.tapColor ?? DEFAULT_TAP_COLOR_ID}
                    onColor={handleTapColor}
                    size={doc.tapSize ?? 1.25}
                    onSize={handleTapSize}
                    onSizeCommit={closeEditorHistoryCoalescing}
                  />
                </div>
              )
            )}
            <div className="editor-preview-area">
              {error ? (
                <div className="stage-error" role="alert">
                  <h2>This edit can’t open right now</h2>
                  <pre>{error}</pre>
                  {target?.sourceRel && !VERSION_ERROR.test(error) ? (
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
                <div
                  className={`editor-preview-row${refView ? " with-reference" : ""}${
                    refView && ghost ? " ghost" : ""
                  }`}
                >
                  <Preview
                    clips={doc.clips}
                    sources={doc.sources}
                    basePath={target?.path ?? ""}
                    playheadMs={playheadMs}
                    playing={playing}
                    trimScrub={trimScrub}
                    onPlayhead={setPlayheadMs}
                    onStop={stopPlaying}
                    armedTap={armedTap}
                    canPlaceTap={canTap}
                    taps={doc.taps ?? []}
                    tapWindowList={tapWindowList}
                    onPlaceTap={handlePlaceTap}
                    onCommitTap={handleCommitTap}
                    onTapContextMenu={handleTapContextMenu}
                    tapMarkerScope={tapMarkerScope}
                    tapStyle={doc.tapStyle ?? DEFAULT_TAP_STYLE_ID}
                    tapColor={doc.tapColor ?? DEFAULT_TAP_COLOR_ID}
                    tapSize={doc.tapSize ?? 1.25}
                    output={doc.settings}
                    masks={doc.masks ?? []}
                    selectedMaskId={selectedMaskId}
                    armedMask={armedMask}
                    onSelectMask={selectMask}
                    onMaskGesture={handleMaskGesture}
                    onDrawMask={handleDrawMask}
                    onCommitMaskRect={handleCommitMaskRect}
                    onCommitMaskPath={handleCommitMaskPath}
                    onMaskContextMenu={handleMaskContextMenu}
                  />
                  {refView && (
                    <ReferencePane
                      clips={refView.clips}
                      sources={refView.sources}
                      basePath={target?.path ?? ""}
                      timeMs={playheadMs + (doc.reference?.offsetMs ?? 0)}
                      playing={playing}
                    />
                  )}
                </div>
              )}
            </div>
          </main>
          {doc && (
            <div className="editor-toolbar">
              <button
                type="button"
                className="btn"
                onClick={handleSplit}
                disabled={!canSplit}
                title="Split the clip under the playhead (S)"
              >
                <ToolIcon id="split" />
                Split
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleFreeze}
                disabled={!canFreeze}
                title="Hold the frame under the playhead as its own clip (F)"
              >
                <ToolIcon id="freeze" />
                Freeze
              </button>
              <button
                type="button"
                className={`btn${armedTap ? " selected" : ""}`}
                aria-pressed={armedTap}
                onClick={() => {
                  setArmedTap((a) => !a);
                  setArmedMask(false);
                }}
                disabled={!armedTap && !canTap}
                title="Tap highlight: click the preview to place a glow at the playhead (T)"
              >
                <ToolIcon id="tap" />
                Tap
              </button>
              <button
                type="button"
                className={`btn${armedMask ? " selected" : ""}`}
                aria-pressed={armedMask}
                onClick={() => {
                  setArmedMask((a) => !a);
                  setArmedTap(false);
                }}
                disabled={!armedMask && !canMask}
                title="Mask: drag over the preview to hide an area from the playhead on (M)"
              >
                <ToolIcon id="mask" />
                Mask
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (selectedMaskId) handleDeleteMask(selectedMaskId);
                  else if (selectedId) handleRemoveClip(selectedId);
                }}
                disabled={!selectedId && !selectedMaskId}
                title={
                  selectedMaskId ? "Delete the selected mask (⌫)" : "Delete the selected clip (⌫)"
                }
              >
                <ToolIcon id="delete" />
                Delete
              </button>
              {selectedClip?.holdMs !== undefined ? (
                <label className="editor-hold" title="Freeze length in seconds">
                  Hold
                  <input
                    key={`${selectedClip.id}:${selectedClip.holdMs}`}
                    className="editor-hold-input"
                    type="number"
                    min={0.1}
                    step={0.1}
                    defaultValue={Number((selectedClip.holdMs / 1000).toFixed(1))}
                    onBlur={(e) => {
                      const s = Number(e.currentTarget.value);
                      if (Number.isFinite(s) && s > 0 && selectedId) {
                        runOp({
                          op: "setHold",
                          clipId: selectedId,
                          holdMs: Math.round(s * 1000),
                        });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  s
                </label>
              ) : (
                <select
                  className="select editor-speed"
                  value={String(selectedClip?.speed ?? 1)}
                  disabled={!selectedClip}
                  title="Playback speed of the selected clip"
                  onChange={(e) => {
                    const speed = Number(e.currentTarget.value);
                    // An off-menu speed (a fit or kb edit) is listed so the select never blanks; picking it changes nothing.
                    if (selectedId && speed !== selectedClip?.speed) {
                      runOp({ op: "setSpeed", clipId: selectedId, speed });
                    }
                    // The popup closes but the select keeps focus, and it eats the next click.
                    e.currentTarget.blur();
                  }}
                >
                  {speedChoices(selectedClip?.speed).map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn editor-play"
                onClick={togglePlay}
                disabled={doc.clips.length === 0}
                title="Play/pause the preview (Space)"
              >
                {playing ? "⏸" : "▶"}
              </button>
              <span className="spacer" />
              {(sceneMedia.length > 0 || doc.reference) && (
                <div className="editor-ref-controls">
                  <label
                    className="editor-ref-label muted"
                    title="Show another scene video beside this one, scrub-locked, to match the edit against"
                  >
                    Compare
                    <select
                      className="select editor-ref-select"
                      value={doc.reference?.rel ?? ""}
                      onChange={(e) => {
                        const rel = e.currentTarget.value;
                        commitDoc(
                          rel
                            ? { ...doc, reference: { rel, offsetMs: 0 } }
                            : { ...doc, reference: undefined },
                          "change reference",
                        );
                        e.currentTarget.blur();
                      }}
                    >
                      <option value="">None</option>
                      {sceneMedia.map((m) => (
                        <option key={m.rel} value={m.rel}>
                          {m.label}
                        </option>
                      ))}
                      {doc.reference && !sceneMedia.some((m) => m.rel === doc.reference?.rel) && (
                        <option value={doc.reference.rel}>
                          {doc.reference.rel.split("/").pop()}
                        </option>
                      )}
                    </select>
                  </label>
                  {doc.reference && (
                    <>
                      <div
                        className="editor-nudge"
                        title="Slide the reference in time by whole frames; positive means it runs ahead"
                      >
                        <button type="button" className="btn" onClick={() => nudgeReference(-10)}>
                          ‹‹
                        </button>
                        <button type="button" className="btn" onClick={() => nudgeReference(-1)}>
                          ‹
                        </button>
                        <span className="editor-nudge-value muted">
                          {Math.round(doc.reference.offsetMs)}ms
                        </span>
                        <button type="button" className="btn" onClick={() => nudgeReference(1)}>
                          ›
                        </button>
                        <button type="button" className="btn" onClick={() => nudgeReference(10)}>
                          ››
                        </button>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        disabled={!canBake}
                        onClick={bakeAsTrim}
                        title="Trim this video's start by the found offset so the match holds at zero (positive offsets only)"
                      >
                        Bake
                      </button>
                      {activeMark === null ? (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setActiveMark(playheadMs)}
                          title="Mark the beat on THIS video, then scrub until the reference shows it and press Match"
                        >
                          Mark
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn selected"
                            onClick={matchReference}
                            title="The reference now shows the marked beat: set the offset from the difference"
                          >
                            Match
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setActiveMark(null)}
                            title="Forget the mark"
                          >
                            ✕
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className={`btn${ghost ? " selected" : ""}`}
                        aria-pressed={ghost}
                        onClick={() => setGhost((g) => !g)}
                        title="Overlay the reference at half opacity for pixel-level matching"
                      >
                        Ghost
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void swapReference()}
                        title="Edit the reference instead; this video becomes the reference"
                      >
                        Swap
                      </button>
                    </>
                  )}
                </div>
              )}
              <span className="muted editor-timecode">
                {(playheadMs / 1000).toFixed(2)}s / {(totalMs / 1000).toFixed(2)}s
              </span>
            </div>
          )}
        </div>
      </div>

      {doc && (
        <Timeline
          clips={doc.clips}
          sources={doc.sources}
          metas={metas}
          selectedId={selectedId}
          playheadMs={playheadMs}
          onSelect={selectClip}
          onPlayhead={handleSeek}
          onEditOp={runOp}
          onTrimScrub={handleTrimScrub}
          onScrubWheel={scrubWheel}
          onDropClipAt={handleInsertClipAt}
          onClipMenu={handleClipContextMenu}
          referenceClips={refView?.clips}
          referenceOffsetMs={doc.reference?.offsetMs ?? 0}
          tapWindowList={tapWindowList}
          masks={doc.masks ?? []}
          showMaskLane={armedMask}
          selectedMaskId={selectedMaskId}
          onSelectMask={selectMask}
          onMaskKeyMenu={handleMaskKeyMenu}
        />
      )}

      {tapMenu && <ContextMenu menu={tapMenu} onClose={() => setTapMenu(null)} />}
      {maskMenu && <ContextMenu menu={maskMenu} onClose={() => setMaskMenu(null)} />}
      {clipMenu && <ContextMenu menu={clipMenu} onClose={() => setClipMenu(null)} />}

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
      {render.phase === "changed" && (
        <footer className="toast toast-info" role="status">
          <span className="toast-msg">
            This edit changed during the render. Render again to include the change.
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
      {notice && (
        <footer className="toast toast-info" role="status">
          <span className="toast-msg" title={notice}>
            {notice}
          </span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
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
      {dropError && (
        <footer className="toast toast-error" role="status">
          <span className="toast-msg" title={dropError}>
            {dropError}
          </span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => setDropError(null)}
          >
            ×
          </button>
        </footer>
      )}
    </div>
  );
}
