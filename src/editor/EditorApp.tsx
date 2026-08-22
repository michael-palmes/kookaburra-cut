import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type EditClip,
  type EditDoc,
  type EditSource,
  type EditTap,
  type EditTarget,
  getEditorTarget,
  listEdits,
  loadEdit,
  openEdit,
  openEditNamed,
  type RenderProgress,
  renderEdit,
  resetEdit,
  saveEdit,
} from "../engine/edit";
import {
  addTap,
  clipIndexAt,
  freezeAt,
  freezeAtEnd,
  insertClipAt,
  moveTap,
  nextClipId,
  nextSourceId,
  nextTapId,
  outputToSource,
  relayout,
  removeClip,
  removeTap,
  retimeTap,
  setClipHold,
  setClipSpeed,
  splitAt,
  tapWindows,
  timelineDurationMs,
} from "../engine/editMath";
import { formatMediaDuration, importMediaBytes, type MediaMeta, mediaMeta } from "../engine/media";
import { readProjectManifestSnapshot } from "../engine/projectEdit";
import { revealApp } from "../engine/reveal";
import { parseSceneDoc } from "../engine/sceneDocSchema";
import { resolveAvailableDeviceSpec } from "../toolkit/device/catalog";
import { ContextMenu, type ContextMenuState } from "../ui/ContextMenu";
import { MediaBrowser } from "../ui/MediaBrowser";
import { mediaCardMenu } from "../ui/mediaCardMenu";
import { hasPendingTextEdit } from "../ui/textEditFocus";
import { useEscapeClose } from "../ui/useEscapeClose";
import {
  bindEditorHistory,
  closeEditorHistoryCoalescing,
  pushEditorHistory,
  takeEditorRedo,
  takeEditorUndo,
} from "./editorHistory";
import { Preview, type TrimScrub } from "./Preview";
import { ReferencePane } from "./ReferencePane";
import { Timeline } from "./Timeline";
import { TAP_ANIMATION_DURATION_MS, tapGradient } from "./tapAnimation";
import {
  DEFAULT_TAP_COLOR_ID,
  DEFAULT_TAP_STYLE_ID,
  TAP_COLORS,
  TAP_STYLES,
} from "./tapStyles.generated";

/** The non-destructive video editor window: magnetic timeline (trim/split/reorder/speed/zoom, filmstrips), playhead-driven preview with spacebar transport and trim-edge live preview, debounced autosave with warn-on-close and corrupt-doc recovery, multi-clip assembly. Renders close the window on success. */

type RenderState =
  | { phase: "idle" }
  | { phase: "rendering"; frame: number; total: number }
  | { phase: "error"; message: string };

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 6];

/** Toolbar glyphs: hand-authored 13px stroke SVGs (the MediaBrowser icon precedent; no icon package). */
function ToolIcon({ id }: { id: "split" | "freeze" | "tap" | "delete" }) {
  const glyph = {
    split: (
      <>
        <path d="M8 1.5v13" strokeDasharray="2.2 1.8" />
        <rect x="1.5" y="4.5" width="4" height="7" rx="1" />
        <rect x="10.5" y="4.5" width="4" height="7" rx="1" />
      </>
    ),
    freeze: <path d="M8 2v12M2.8 5l10.4 6M13.2 5L2.8 11" />,
    tap: (
      <>
        <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="5.4" />
      </>
    ),
    delete: (
      <>
        <path d="M2.5 4.5h11" />
        <path d="M6 4.5V3h4v1.5" />
        <path d="M4 4.5l.8 9h6.4l.8-9" />
      </>
    ),
  }[id];
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}
const AUTOSAVE_DEBOUNCE_MS = 400;
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
    bindEditorHistory(t.slug, t.name);
    renderStaleRef.current = false;
    targetRef.current = t;
    docRef.current = null;
    setTarget(t);
    setDoc(null);
    setMetas({});
    setError(null);
    setSaveError(null);
    setRender({ phase: "idle" });
    setSelectedId(null);
    setPlayheadMs(0);
    setPlaying(false);
    const isCurrentTarget = () =>
      targetRef.current?.slug === t.slug && targetRef.current?.name === t.name;
    loadEdit(t.slug, t.name)
      .then((d) => {
        if (!isCurrentTarget()) return;
        // Normalise on load: the timeline is magnetic, startMs is derived state.
        const loaded = { ...d, clips: relayout(d.clips) };
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
          if (isCurrentTarget()) setMetas(Object.fromEntries(entries));
        });
      })
      .catch((e) => {
        if (isCurrentTarget()) setError(String(e));
      });
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
    (next: EditDoc, label: string, options: { record?: boolean; coalesceKey?: string } = {}) => {
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

  /** Commit a clips-only mutation (what the timeline emits). */
  const commit = useCallback(
    (clips: EditClip[], label: string) => {
      if (!doc || !target) return;
      commitDoc({ ...doc, clips }, label);
    },
    [doc, target, commitDoc],
  );

  // Focused native Edit-menu events land in this window only. Replays use commitDoc without recording.
  useEffect(() => {
    const run = (direction: "undo" | "redo") => {
      if (hasPendingTextEdit()) {
        document.execCommand(direction);
        return;
      }
      if (render.phase === "rendering") return;
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
        devices.forEach((d, i) => {
          if (d.media?.kind === "video") {
            const model = resolveAvailableDeviceSpec(d.model).name;
            entries.push({ rel: d.media.src, label: `Device ${i + 1} · ${model}` });
          }
        });
        for (const [id, m] of Object.entries(sceneDoc.compare?.b?.media ?? {})) {
          if (m.kind !== "video") continue;
          const i = devices.findIndex((d) => d.id === id);
          entries.push({ rel: m.src, label: `After side · Device ${i >= 0 ? i + 1 : id}` });
        }
        if (sceneDoc.videoWindow?.media?.src) {
          entries.push({ rel: sceneDoc.videoWindow.media.src, label: "Video window" });
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
      "Discard this edit and start over from the source video? The current document is kept beside it as a .json.bak backup.",
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
    const durationMs = timelineDurationMs(doc.clips);
    setPlayheadMs((p) => Math.min(p, durationMs));
  }, [doc, selectedId]);

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
    if (!target || !doc) return;
    setRender({ phase: "rendering", frame: 0, total: 1 });
    try {
      await flushSave(); // render_edit reads edit.json from disk, so persist the latest doc first
      await renderEdit(target.slug, target.name, (p: RenderProgress) =>
        setRender({ phase: "rendering", frame: p.frame, total: p.total }),
      );
      renderStaleRef.current = false;
      // Success: tell the main window (media library refresh) and close this one.
      await emit("kookaburra://media-changed", { slug: target.slug, name: target.name });
      await getCurrentWindow().close();
    } catch (e) {
      setRender({ phase: "error", message: String(e) });
    }
  }, [target, doc, flushSave]);

  /** Shared add/insert flow: probe `rel`, reuse-or-create its EditSource, build a full-length clip and commit `place`'s arrangement; mediaMeta also warms the filmstrip cache. */
  const spliceClip = useCallback(
    (rel: string, place: (clips: EditClip[], clip: EditClip) => EditClip[], label: string) => {
      if (!doc || !target) return;
      const requestedTarget = target;
      mediaMeta(target.slug, rel)
        .then((meta) => {
          if (meta.kind !== "video") throw new Error("only videos can be added to an edit");
          const current = docRef.current;
          if (
            !current ||
            targetRef.current?.slug !== requestedTarget.slug ||
            targetRef.current.name !== requestedTarget.name
          ) {
            return;
          }
          const existing = current.sources.find((s) => s.rel === rel);
          const sourceId = existing?.id ?? nextSourceId(current.sources);
          const sources = existing
            ? current.sources
            : [
                ...current.sources,
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
            id: nextClipId(current.clips),
            sourceId,
            inMs: 0,
            outMs: meta.durationMs,
            speed: 1,
            startMs: 0,
          };
          setMetas((prev) => ({ ...prev, [sourceId]: meta }));
          commitDoc({ ...current, sources, clips: place(current.clips, clip) }, label);
        })
        .catch((e) => setSaveError(`Couldn't add the clip: ${String(e)}`));
    },
    [doc, target, commitDoc],
  );

  /** Insert a full-length clip of `rel` at clip position `index` (end when omitted). */
  const handleAddClip = useCallback(
    (rel: string, index?: number) =>
      spliceClip(
        rel,
        (clips, clip) => {
          const next = [...clips];
          next.splice(Math.max(0, Math.min(next.length, index ?? next.length)), 0, clip);
          return relayout(next);
        },
        "add clip",
      ),
    [spliceClip],
  );

  /** Splice a full-length clip of `rel` in at output time `tMs`; mid-clip splits the clip under it (the freeze-frame pattern). */
  const handleInsertClipAt = useCallback(
    (rel: string, tMs: number) =>
      spliceClip(rel, (clips, clip) => insertClipAt(clips, tMs, clip), "insert clip"),
    [spliceClip],
  );

  const handleSplit = useCallback(() => {
    if (!doc) return;
    const next = splitAt(doc.clips, playheadMs, nextClipId(doc.clips));
    if (next) commit(next, "split clip");
  }, [doc, playheadMs, commit]);

  /** Freeze the frame under the playhead for a default beat; the Hold field retimes it. */
  const DEFAULT_HOLD_MS = 2000;
  const handleFreeze = useCallback(() => {
    if (!doc) return;
    const total = timelineDurationMs(doc.clips);
    const outputFps = doc.settings.fps > 0 ? doc.settings.fps : 60;
    const atEnd = Math.abs(playheadMs - total) <= 500 / outputFps;
    const next = atEnd
      ? freezeAtEnd(doc.clips, outputFps, DEFAULT_HOLD_MS)
      : freezeAt(doc.clips, playheadMs, DEFAULT_HOLD_MS);
    if (next) commit(next, "freeze frame");
  }, [doc, playheadMs, commit]);

  /** Commit a taps-only mutation (placement, drag, context-menu edits). */
  const commitTaps = useCallback(
    (taps: EditTap[], label: string) => {
      if (!doc || !target) return;
      commitDoc({ ...doc, taps }, label);
    },
    [doc, target, commitDoc],
  );

  const handlePlaceTap = useCallback(
    (pos: [number, number]) => {
      if (!doc) return;
      const at = outputToSource(doc.clips, playheadMs);
      if (!at) return;
      const taps = doc.taps ?? [];
      commitTaps(
        addTap(taps, { id: nextTapId(taps), sourceId: at.sourceId, sourceMs: at.sourceMs, pos }),
        "add tap",
      );
    },
    [doc, playheadMs, commitTaps],
  );

  const handleCommitTap = useCallback(
    (id: string, pos: [number, number]) => {
      if (!doc) return;
      commitTaps(moveTap(doc.taps ?? [], id, pos), "move tap");
    },
    [doc, commitTaps],
  );

  const handleTapStyle = useCallback(
    (id: string) => {
      if (!doc || !target) return;
      commitDoc({ ...doc, tapStyle: id }, "change tap style");
    },
    [doc, target, commitDoc],
  );

  const handleTapColor = useCallback(
    (id: string) => {
      if (!doc || !target) return;
      commitDoc({ ...doc, tapColor: id }, "change tap colour");
    },
    [doc, target, commitDoc],
  );

  const handleTapSize = useCallback(
    (size: number) => {
      if (!doc || !target) return;
      commitDoc({ ...doc, tapSize: size }, "resize tap", { coalesceKey: "tap-size" });
    },
    [doc, target, commitDoc],
  );

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

  /** Every tap's visible output windows, flattened for the preview glow and the ruler markers. */
  const tapWindowList = useMemo(
    () =>
      (doc?.taps ?? []).flatMap((tap) =>
        tapWindows(doc?.clips ?? [], tap, TAP_ANIMATION_DURATION_MS).map((w) => ({ tap, ...w })),
      ),
    [doc],
  );

  const handleTapContextMenu = useCallback(
    (id: string, x: number, y: number) => {
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
              if (!doc) return;
              const at = outputToSource(doc.clips, playheadMs);
              if (at) {
                commitTaps(retimeTap(doc.taps ?? [], id, at.sourceId, at.sourceMs), "retime tap");
              }
            },
          },
          {
            id: "delete",
            label: "Delete",
            confirmLabel: "Really delete?",
            danger: true,
            onSelect: () => {
              if (doc) commitTaps(removeTap(doc.taps ?? [], id), "delete tap");
            },
          },
        ],
      });
    },
    [doc, playheadMs, canTap, commitTaps],
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
            label: "Insert video at playhead",
            disabled: !rel,
            title: "Splice this clip's video in at the playhead, full length",
            onSelect: () => {
              if (rel) handleInsertClipAt(rel, playheadRef.current);
            },
          },
          {
            id: "append",
            label: "Append video to the end",
            disabled: !rel,
            title: "Add this clip's video again as the last clip",
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
              if (doc) commit(removeClip(doc.clips, id), "remove clip");
            },
          },
        ],
      });
    },
    [doc, handleInsertClipAt, handleAddClip, commit],
  );

  // Space plays/pauses; S/F split/freeze at the playhead; Delete/Backspace removes the selected clip; Escape deselects. Lives below canSplit/canFreeze so the dependency array can read them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
      // The media panel has its own keyboard semantics, and an open fullscreen preview owns the transport keys (its VideoPlayer handles them).
      if (t?.closest(".editor-media-panel")) return;
      if (document.querySelector(".media-preview")) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === " ") {
        e.preventDefault();
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
      } else if ((e.key === "Delete" || e.key === "Backspace") && doc && selectedId) {
        e.preventDefault();
        commit(removeClip(doc.clips, selectedId), "remove clip");
      } else if (e.key === "Escape") {
        // Disarm the tap tool first, deselect only when it wasn't armed (the AnimationLane pattern).
        if (armedTap) setArmedTap(false);
        else setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    doc,
    selectedId,
    commit,
    togglePlay,
    stepFrames,
    handleSplit,
    handleFreeze,
    canSplit,
    canFreeze,
    armedTap,
    canTap,
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
        {/* The shared MediaBrowser as a persistent side panel: same cards as the main window's Media modal; videos drag into the timeline (this window disables Tauri's native drag-drop handler to free HTML5 DnD). */}
        <aside className="editor-media-panel" aria-label="Project media">
          {target && (
            <MediaBrowser
              slug={target.slug}
              projectPath={target.path}
              refreshKey={mediaRefresh}
              compact
              draggableVideos
              kinds={["video"]}
              hint="Drag a video into the timeline"
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
            {doc && ((doc.taps?.length ?? 0) > 0 || armedTap) && (
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
            )}
            <div className="editor-preview-area">
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
                onClick={() => setArmedTap((a) => !a)}
                disabled={!armedTap && !canTap}
                title="Tap highlight: click the preview to place a glow at the playhead (T)"
              >
                <ToolIcon id="tap" />
                Tap
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  selectedId && commit(removeClip(doc.clips, selectedId), "remove clip")
                }
                disabled={!selectedId}
                title="Delete the selected clip (⌫)"
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
                        commit(
                          setClipHold(doc.clips, selectedId, Math.round(s * 1000)),
                          "retime freeze",
                        );
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
                  value={selectedClip?.speed ?? 1}
                  disabled={!selectedClip}
                  title="Playback speed of the selected clip"
                  onChange={(e) => {
                    if (selectedId) {
                      commit(
                        setClipSpeed(doc.clips, selectedId, Number(e.currentTarget.value)),
                        "change clip speed",
                      );
                    }
                    // The popup closes but the select keeps focus, and it eats the next click.
                    e.currentTarget.blur();
                  }}
                >
                  {SPEED_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}×
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
          onSelect={setSelectedId}
          onPlayhead={handleSeek}
          onCommit={commit}
          onTrimScrub={handleTrimScrub}
          onScrubWheel={scrubWheel}
          onDropClipAt={handleInsertClipAt}
          onClipMenu={handleClipContextMenu}
          referenceClips={refView?.clips}
          referenceOffsetMs={doc.reference?.offsetMs ?? 0}
          tapWindowList={tapWindowList}
        />
      )}

      {tapMenu && <ContextMenu menu={tapMenu} onClose={() => setTapMenu(null)} />}
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
