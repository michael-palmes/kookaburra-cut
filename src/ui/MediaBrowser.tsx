import { listen } from "@tauri-apps/api/event";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listEdits } from "../engine/edit";
import {
  deleteGlobalScreenshot,
  formatMediaDuration,
  fsUrl,
  type GlobalScreenshot,
  globalScreenshotMeta,
  importGlobalScreenshots,
  importMedia,
  listGlobalScreenshots,
  listProjectMedia,
  MEDIA_DRAG_TYPE,
  type MediaMeta,
  mediaMeta,
  revealPath,
} from "../engine/media";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { SegmentedRow, ToggleFieldset } from "./inspector/rows";
import { modalHost } from "./modalHost";
import { SceneMenuIcon } from "./sceneMenu";
import { UnusedMediaSheet } from "./UnusedMediaSheet";
import { useEscapeClose } from "./useEscapeClose";
import { VideoPlayer } from "./VideoPlayer";

/** The reusable project-media browser: a card grid of the open project's `assets/`, poster thumbnails, hover-scrub across ~10 pre-extracted frames, Edited chips, multi-file import and a preview overlay (window-wide, or scoped to the drill under `inspectorPreview`). Thumbnails generate lazily in the background, one file at a time, so a folder of long recordings never blocks the grid. The host owns the shell (main-window modal vs inspector drill-in vs editor side panel) and supplies the per-card ⋯/right-click menu via `cardMenu`, the only part that differs (2026-07-12: the old per-card button row overflowed). */

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm"];
/** Names the toolbar ⋯ menu and tells its button whether the open menu is its own (cards share the one ContextMenu). */
const MEDIA_ACTIONS_MENU = "Media actions";
const MEDIA_PICKER_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];
const MEDIA_PREVIEW_FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "summary",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function mediaPreviewTabTarget(
  focusables: readonly HTMLElement[],
  activeElement: HTMLElement | null,
  backwards: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const activeIndex = activeElement ? focusables.indexOf(activeElement) : -1;
  if (backwards) return activeIndex <= 0 ? (focusables.at(-1) ?? null) : null;
  return activeIndex < 0 || activeIndex === focusables.length - 1 ? focusables[0] : null;
}

/** Prev/next through the grid as the user sees it, wrapping at both ends; a refresh that drops the previewed file (index -1) restarts from the top. */
export function mediaPreviewStep(
  list: readonly string[],
  current: string,
  delta: number,
): string | null {
  if (list.length === 0) return null;
  const index = list.indexOf(current);
  const from = index < 0 ? 0 : index;
  return list[(from + delta + list.length) % list.length] ?? null;
}

function mediaPreviewFocusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(MEDIA_PREVIEW_FOCUSABLE))
    .filter((element) => {
      if (element.tabIndex < 0 || element.matches(":disabled")) return false;
      if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getClientRects().length > 0
      );
    })
    .map((element, order) => ({ element, order }))
    .sort((a, b) => {
      if (a.element.tabIndex === b.element.tabIndex) return a.order - b.order;
      if (a.element.tabIndex === 0) return 1;
      if (b.element.tabIndex === 0) return -1;
      return a.element.tabIndex - b.element.tabIndex;
    })
    .map(({ element }) => element);
}

export function MediaBrowserError({ message }: { message: string }) {
  return (
    <span className="modal-error media-add-error" role="alert">
      {message}
    </span>
  );
}

export async function runMediaPickSingleFlight(
  busyRef: { current: boolean },
  task: () => Promise<void>,
): Promise<boolean> {
  if (busyRef.current) return false;
  busyRef.current = true;
  try {
    await task();
    return true;
  } finally {
    busyRef.current = false;
  }
}

/** Kind by extension, instant (metas stream in later; the backend agrees on these). */
function kindOfRel(rel: string): "image" | "video" {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext) ? "image" : "video";
}

export interface MediaActionContext {
  /** The owning edit's name when this file is a rendered editor output, else null. */
  editedOf: string | null;
}

/** Path actions every card gets regardless of host (the host menu still owns Insert/Edit/Delete); slotted just above the first danger item so Delete stays last. */
function withPathItems(
  items: ContextMenuItem[],
  absPath: string,
  onError: (message: string) => void,
): ContextMenuItem[] {
  const path: ContextMenuItem[] = [
    {
      id: "copy-path",
      label: "Copy path",
      onSelect: () => void navigator.clipboard?.writeText(absPath),
    },
    {
      id: "reveal",
      label: "Show in Finder",
      onSelect: () => {
        revealPath(absPath).catch((e) => {
          console.warn(`[media] reveal failed for ${absPath}:`, e);
          onError(`Couldn't show the file: ${String(e)}`);
        });
      },
    },
  ];
  const at = items.findIndex((it) => it.danger);
  return at < 0 ? [...items, ...path] : [...items.slice(0, at), ...path, ...items.slice(at)];
}

/** The import button, extracted so modal hosts can seat it in their title row (top-right, across from the heading). Hosts pass `onImported` to bump an embedded browser's `refreshKey`. */
export function AddMediaButton({
  slug,
  kinds,
  onImported,
}: {
  slug: string;
  kinds?: ("video" | "image")[];
  onImported?: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleAdd = useCallback(async () => {
    const extensions =
      kinds?.length === 1
        ? kinds[0] === "image"
          ? [...IMAGE_EXTENSIONS]
          : [...VIDEO_EXTENSIONS]
        : [...MEDIA_PICKER_EXTENSIONS];
    const picked = await openFilePicker({
      multiple: true,
      title: "Add media to this project",
      filters: [{ name: "Media", extensions }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      await importMedia(slug, paths);
      onImported?.();
    } catch (e) {
      // The drag-drop import path toasts its failures; the picker path must not fail silently either.
      console.warn("[media] import failed:", e);
      setError(`Import failed: ${String(e)}`);
    } finally {
      setImporting(false);
    }
  }, [slug, kinds, onImported]);
  return (
    <>
      <button
        type="button"
        className="btn primary media-browser-add"
        onClick={() => void handleAdd()}
        disabled={importing}
      >
        {importing ? "Adding…" : "＋ Add media"}
      </button>
      {error && <MediaBrowserError message={error} />}
    </>
  );
}

/** The library import button: same flow as AddMediaButton but into the global media library folder (~/Kookaburra Cut/screenshots). */
function AddGlobalScreenshotButton({ onImported }: { onImported: (names: string[]) => void }) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleAdd = useCallback(async () => {
    const picked = await openFilePicker({
      multiple: true,
      title: "Add to the media library",
      filters: [{ name: "Media", extensions: [...MEDIA_PICKER_EXTENSIONS] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const names = await importGlobalScreenshots(paths);
      onImported(names);
    } catch (e) {
      console.warn("[media] global screenshot import failed:", e);
      setError(`Import failed: ${String(e)}`);
    } finally {
      setImporting(false);
    }
  }, [onImported]);
  return (
    <>
      <button
        type="button"
        className="btn primary media-browser-add"
        onClick={() => void handleAdd()}
        disabled={importing}
      >
        {importing ? "Adding…" : "＋ Add to library"}
      </button>
      {error && <MediaBrowserError message={error} />}
    </>
  );
}

function VideoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h5A1.5 1.5 0 0 1 10 4.5v7A1.5 1.5 0 0 1 8.5 13h-5A1.5 1.5 0 0 1 2 11.5v-7Zm9 2.3 3-2.1v6.6l-3-2.1V6.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 3h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm.5 8.5h9L9.6 7.7l-2.2 2.6-1.5-1.6-2.4 2.8ZM5.75 7.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ProjectIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.2 14.5 5.2 8 8.2 1.5 5.2 8 2.2Zm5.6 5.2L8 10 2.4 7.4l-.9.4L8 10.9l6.5-3.1-.9-.4Zm0 2.6L8 12.6 2.4 10l-.9.4L8 13.5l6.5-3.1-.9-.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="8" cy="12.5" r="1" />
    </svg>
  );
}

export interface MediaBrowserProps {
  slug: string;
  /** Absolute project folder, full-res previews load from it via the asset protocol. */
  projectPath: string;
  /** Bump to re-scan from outside (e.g. after a drag-drop import). */
  refreshKey?: number;
  /** Tighter grid for narrow hosts (the editor's side panel). */
  compact?: boolean;
  /** Scope the preview to the inspector panel and add prev/next stepping through the grid. Inspector hosts only: the media library modal and the editor side panel keep the window-wide preview. */
  inspectorPreview?: boolean;
  /** Media cards become HTML5-draggable once probed (`MEDIA_DRAG_TYPE` carries the rel path). Editor-window only: the main window's native drag-drop interception eats these. */
  draggableMedia?: boolean;
  /** Small muted hint in the toolbar row (e.g. the drag affordance). */
  hint?: string;
  /** Restrict the browser to these kinds (e.g. background images). Filters the grid and the Add-media file picker; no toggle is shown. */
  kinds?: ("video" | "image")[];
  /** Show a Project/Global source toggle: Global browses ~/Kookaburra Cut/screenshots and picking copies the file into this project's assets first (copy-on-use). */
  globalToggle?: boolean;
  /** Show a Video/Images toggle in the toolbar, defaulting to video (Change media). Together with `globalToggle` the browser wraps in a ToggleFieldset, the source switch straddling its top edge. */
  kindToggle?: boolean;
  /** The kind tab the toggle starts on (default "video"). */
  kindDefault?: "video" | "image";
  /** Hide the built-in Add button: the host renders `<AddMediaButton>` in its own title row and bumps `refreshKey` on import. */
  hideAdd?: boolean;
  /** Show the "Delete unused…" action beside Add media (management surfaces only: the media library modal and the Project tab's media drill-in). A picker's job is choosing a file, so a bulk sweep never appears in one. "menu" collapses it into a ⋯ overflow for narrow hosts: the toggles column is the only part of the bar that can shrink, so in the inspector drill the text button squeezed the Video/Images toggle until "Images" clipped away. */
  cleanupUnused?: boolean | "menu";
  /** Per-card ⋯/right-click menu items; omit for none (the editor panel drags instead). The browser hosts one ContextMenu, the house two-step confirm rides `confirmLabel` (see ui/mediaCardMenu.tsx for the shared Edit/Insert/Delete set). */
  cardMenu?: (rel: string, meta: MediaMeta | null, ctx: MediaActionContext) => ContextMenuItem[];
  /** Highlight this rel as the current selection (e.g. the scene's background video). */
  selectedRel?: string | null;
  /** Single-select picker mode: clicking a card chooses it instead of opening the fullscreen preview (which moves to a per-card "Preview" action). Import-in-place and hover-scrub keep working; the wizard host advances on the callback. */
  onPick?: (rel: string, meta: MediaMeta | null) => void;
}

export function mediaCardActions(
  onPick: (() => void) | undefined,
  onPreview: () => void,
  onMenu?: (x: number, y: number) => void,
) {
  return { activate: onPick ?? onPreview, preview: onPreview, openMenu: onMenu };
}

export function MediaCard({
  rel,
  meta,
  metaFailed,
  edited,
  canDrag,
  selected,
  onMenu,
  onPreview,
  onPick,
  disabled,
}: {
  rel: string;
  meta: MediaMeta | null;
  /** Preview/metadata generation failed, say so instead of "Preparing…" forever. */
  metaFailed: boolean;
  /** True for a rendered editor output whose edit document still exists. */
  edited: boolean;
  canDrag: boolean;
  /** Accent-ring the card (the host's current selection). */
  selected: boolean;
  /** Open the card's action menu at (x, y); the ⋯ button and right-click share it. */
  onMenu?: (x: number, y: number) => void;
  onPreview: () => void;
  /** Picker mode: card click chooses this file (preview demotes to an action button). */
  onPick?: () => void;
  disabled?: boolean;
}) {
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const name = rel.replace(/^assets\//, "");
  const actions = mediaCardActions(onPick, onPreview, onMenu);
  const scrub =
    meta && scrubIndex !== null && meta.scrubPaths.length > 0
      ? meta.scrubPaths[Math.min(scrubIndex, meta.scrubPaths.length - 1)]
      : null;
  const imageSrc = scrub ?? meta?.posterPath ?? null;

  return (
    <div
      className={`media-card${selected ? " selected" : ""}`}
      draggable={canDrag}
      style={{ position: "relative" }}
    >
      <button
        type="button"
        className="media-card-activate"
        draggable={canDrag}
        aria-label={onPick ? `Use ${name}` : `Preview ${name}`}
        aria-pressed={onPick ? selected : undefined}
        aria-busy={disabled || undefined}
        disabled={disabled}
        onClick={actions.activate}
        onDragStart={(e) => {
          if (!canDrag) return;
          e.dataTransfer.setData(MEDIA_DRAG_TYPE, rel);
          e.dataTransfer.setData("text/plain", rel);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onContextMenu={
          onMenu
            ? (e) => {
                e.preventDefault();
                actions.openMenu?.(e.clientX, e.clientY);
              }
            : undefined
        }
        onMouseMove={(e) => {
          if (!meta || meta.scrubPaths.length === 0 || !thumbRef.current) return;
          const rect = thumbRef.current.getBoundingClientRect();
          if (e.clientY < rect.top || e.clientY > rect.bottom) {
            setScrubIndex(null);
            return;
          }
          const t = (e.clientX - rect.left) / Math.max(1, rect.width);
          setScrubIndex(
            Math.max(
              0,
              Math.min(meta.scrubPaths.length - 1, Math.floor(t * meta.scrubPaths.length)),
            ),
          );
        }}
        onMouseLeave={() => setScrubIndex(null)}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          width: "100%",
          height: "100%",
          padding: 0,
          color: "inherit",
          background: "transparent",
          border: 0,
          borderRadius: "inherit",
          cursor: "inherit",
        }}
      />
      <div
        ref={thumbRef}
        className={`media-thumb${meta?.kind === "image" ? " media-thumb-alpha" : ""}`}
      >
        {imageSrc ? (
          <img src={fsUrl(imageSrc)} alt="" draggable={false} />
        ) : (
          <span className="media-thumb-pending">
            {metaFailed ? "Preview failed" : "Preparing…"}
          </span>
        )}
        {meta?.kind === "video" && (
          <span className="media-duration">{formatMediaDuration(meta.durationMs)}</span>
        )}
        {edited && <span className="media-badge">Edited</span>}
        {onPick && (
          <button
            type="button"
            className="media-expand"
            aria-label={`Preview ${name}`}
            title="Preview"
            style={{ zIndex: 2 }}
            onContextMenu={
              onMenu
                ? (e) => {
                    e.preventDefault();
                    actions.openMenu?.(e.clientX, e.clientY);
                  }
                : undefined
            }
            onClick={actions.preview}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M9.5 2H14v4.5M14 2 9 7M6.5 14H2V9.5M2 14l5-5"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="media-card-body">
        <span className="media-name" title={name}>
          {name}
        </span>
        <div className="media-card-foot">
          <span className="media-meta-line">
            {meta
              ? meta.kind === "video"
                ? `${meta.width}×${meta.height} · ${meta.fps.toFixed(0)} fps`
                : `${meta.width}×${meta.height} · image`
              : "…"}
          </span>
          {onMenu && (
            <button
              type="button"
              className="media-menu-btn"
              aria-label={`Actions for ${name}`}
              title="Actions"
              style={{ position: "relative", zIndex: 2 }}
              onContextMenu={(e) => {
                e.preventDefault();
                actions.openMenu?.(e.clientX, e.clientY);
              }}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                actions.openMenu?.(r.left, r.bottom + 4);
              }}
            >
              ⋯
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepChevron({ back }: { back?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={back ? "M12 5l-5 5 5 5" : "M8 5l5 5-5 5"} />
    </svg>
  );
}

/** The preview layer itself: window-wide by default, scoped to the inspector drill (with prev/next chevrons) under `panel`. */
export function MediaPreviewOverlay({
  name,
  src,
  kind,
  fps,
  panel,
  canStep,
  onStep,
  onClose,
  closeRef,
}: {
  name: string;
  /** Already through `fsUrl`: the host owns path resolution. */
  src: string;
  kind: "image" | "video";
  fps?: number;
  panel?: boolean;
  canStep: boolean;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div
      className={`media-preview${panel ? " panel" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${name}`}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const target = mediaPreviewTabTarget(
          mediaPreviewFocusables(event.currentTarget),
          document.activeElement instanceof HTMLElement ? document.activeElement : null,
          event.shiftKey,
        );
        if (!target) return;
        event.preventDefault();
        target.focus({ preventScroll: true });
      }}
    >
      {/* Click-anywhere-to-close, as a real button so keyboards get it too. */}
      <button
        type="button"
        className="media-preview-backdrop"
        aria-label="Close preview"
        tabIndex={-1}
        onClick={onClose}
      />
      {kind === "image" ? (
        <img src={src} alt={name} />
      ) : (
        // Preview-only playback (never the export path); custom minimal controls.
        <VideoPlayer src={src} fps={fps} autoPlay />
      )}
      {panel && (
        <>
          <button
            type="button"
            className="media-preview-step prev"
            aria-label="Previous file"
            title="Previous (←)"
            disabled={!canStep}
            onClick={() => onStep(-1)}
          >
            <StepChevron back />
          </button>
          <button
            type="button"
            className="media-preview-step next"
            aria-label="Next file"
            title="Next (→)"
            disabled={!canStep}
            onClick={() => onStep(1)}
          >
            <StepChevron />
          </button>
        </>
      )}
      <button
        ref={closeRef}
        type="button"
        className="toast-close media-preview-close"
        aria-label="Close preview"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

export function MediaBrowser({
  slug,
  projectPath,
  refreshKey = 0,
  compact,
  inspectorPreview,
  draggableMedia,
  hint,
  kinds,
  kindToggle,
  kindDefault,
  globalToggle,
  hideAdd,
  cleanupUnused,
  cardMenu,
  selectedRel,
  onPick,
}: MediaBrowserProps) {
  const [rels, setRels] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [metas, setMetas] = useState<Record<string, MediaMeta>>({});
  /** Files whose metadata/preview generation failed: their cards say so instead of sitting on "Preparing…" forever. Cleared on a later success. */
  const [metaFailed, setMetaFailed] = useState<ReadonlySet<string>>(new Set());
  const [edits, setEdits] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const [kindTab, setKindTab] = useState<"video" | "image">(kindDefault ?? "video");
  const [sourceTab, setSourceTab] = useState<"project" | "global">("project");
  const [globalShots, setGlobalShots] = useState<GlobalScreenshot[] | null>(null);
  const [globalMetas, setGlobalMetas] = useState<Record<string, MediaMeta>>({});
  const [globalFailed, setGlobalFailed] = useState<ReadonlySet<string>>(new Set());
  /** Copy-on-use failures must never be silent (the pick just wouldn't land). */
  const [pickError, setPickError] = useState<string | null>(null);
  const pickBusyRef = useRef(false);
  const [pickBusy, setPickBusy] = useState(false);
  const [unusedOpen, setUnusedOpen] = useState(false);

  // The visible kind set: a fixed `kinds` filter wins; else the toolbar toggle; else all.
  const allowedKinds = kinds ?? (kindToggle ? [kindTab] : null);
  const visibleRels = rels?.filter((rel) => !allowedKinds || allowedKinds.includes(kindOfRel(rel)));
  // The library grid honours the same kind filter, so an image-only picker never offers a video.
  const visibleGlobal = globalShots?.filter(
    (s) => !allowedKinds || allowedKinds.includes(kindOfRel(s.name)),
  );

  const refresh = useCallback(() => {
    listProjectMedia(slug)
      .then(setRels)
      .catch(() => setRels([]));
    // Edit documents, to map rendered outputs back to their edits.
    listEdits(slug)
      .then(setEdits)
      .catch(() => setEdits([]));
  }, [slug]);

  useEffect(() => {
    // refreshKey exists purely to re-trigger the scan.
    void refreshKey;
    refresh();
  }, [refresh, refreshKey]);

  // Any import (a window drop, another window, the Add button) jumps to the imported kind's tab, so the new file is visibly first instead of hiding behind the other tab; the newest-first Rust sort puts it on top.
  useEffect(() => {
    const unlisten = listen<{ rels?: string[] }>("kookaburra://media-imported", (e) => {
      const first = e.payload.rels?.[0];
      if (!first) return;
      const kind = kindOfRel(first);
      if (kinds && !kinds.includes(kind)) return;
      setSourceTab("project");
      if (!kinds && kindToggle) setKindTab(kind);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [kinds, kindToggle]);

  const refreshGlobal = useCallback(() => {
    listGlobalScreenshots()
      .then(setGlobalShots)
      .catch(() => setGlobalShots([]));
  }, []);

  useEffect(() => {
    void refreshKey;
    if (globalToggle && sourceTab === "global") refreshGlobal();
  }, [globalToggle, sourceTab, refreshGlobal, refreshKey]);

  // The global grid's metadata pass, same one-at-a-time shape as the project pass below.
  useEffect(() => {
    if (!globalShots || sourceTab !== "global") return;
    let cancelled = false;
    (async () => {
      for (const shot of globalShots) {
        if (cancelled) return;
        try {
          const meta = await globalScreenshotMeta(shot.name);
          if (cancelled) return;
          setGlobalFailed((prev) => {
            if (!prev.has(shot.name)) return prev;
            const next = new Set(prev);
            next.delete(shot.name);
            return next;
          });
          setGlobalMetas((prev) => {
            const old = prev[shot.name];
            if (old && old.sha === meta.sha && old.posterPath === meta.posterPath) return prev;
            return { ...prev, [shot.name]: meta };
          });
        } catch (e) {
          console.warn(`[media] global screenshot metadata failed for ${shot.name}:`, e);
          if (!cancelled) {
            setGlobalFailed((prev) => (prev.has(shot.name) ? prev : new Set(prev).add(shot.name)));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [globalShots, sourceTab]);

  /** Copy-on-use: import the global file into this project's assets, then hand the pick to the host as a normal project rel. */
  const pickGlobal = useCallback(
    async (shot: GlobalScreenshot) => {
      if (!onPick) return;
      await runMediaPickSingleFlight(pickBusyRef, async () => {
        setPickBusy(true);
        setPickError(null);
        try {
          const [rel] = await importMedia(slug, [shot.absPath]);
          if (rel) await onPick(rel, globalMetas[shot.name] ?? null);
        } catch (e) {
          console.warn(`[media] copy-on-use failed for ${shot.name}:`, e);
          setPickError(`Couldn't copy into the project: ${String(e)}`);
        } finally {
          setPickBusy(false);
        }
      });
    },
    [onPick, slug, globalMetas],
  );

  // Metadata pass, one file at a time: first sight generates (ffprobe + ffmpeg); everything else revalidates against the backend's size+mtime stamp (hash-free, so this is cheap on every scan); a changed/re-rendered file regenerates on view. Old entries stay on screen until their replacement lands; identical results are dropped so unchanged cards never re-render.
  useEffect(() => {
    if (!rels) return;
    let cancelled = false;
    (async () => {
      for (const rel of rels) {
        if (cancelled) return;
        try {
          const meta = await mediaMeta(slug, rel);
          if (cancelled) return;
          setMetaFailed((prev) => {
            if (!prev.has(rel)) return prev;
            const next = new Set(prev);
            next.delete(rel);
            return next;
          });
          setMetas((prev) => {
            const old = prev[rel];
            if (old && old.sha === meta.sha && old.posterPath === meta.posterPath) return prev;
            return { ...prev, [rel]: meta };
          });
        } catch (e) {
          console.warn(`[media] metadata failed for ${rel}:`, e);
          if (!cancelled) {
            setMetaFailed((prev) => (prev.has(rel) ? prev : new Set(prev).add(rel)));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rels, slug]);

  /** The owning edit's name when `rel` is a rendered output (`assets/<name>-edited.mp4`) whose document still exists. */
  const editNameOf = useCallback(
    (rel: string) => {
      const m = /^assets\/(.+)-edited\.mp4$/.exec(rel);
      return m && edits.includes(m[1]) ? m[1] : null;
    },
    [edits],
  );

  const editedRels = useMemo(
    () => new Set((rels ?? []).filter((rel) => editNameOf(rel) !== null)),
    [rels, editNameOf],
  );

  const previewOpen = preview !== null;
  const previewMeta = preview
    ? ((sourceTab === "global" ? globalMetas[preview] : metas[preview]) ?? null)
    : null;
  const previewSrc = preview
    ? sourceTab === "global"
      ? (globalShots?.find((s) => s.name === preview)?.absPath ?? null)
      : `${projectPath}/${preview}`
    : null;
  // Metadata streams in one file at a time, so a freshly listed image has none yet: fall back to the extension rather than handing a PNG to the video player.
  const previewKind = preview ? (previewMeta?.kind ?? kindOfRel(preview)) : "image";

  // The grid as the user sees it (current filter, Rust's newest-first sort), for prev/next; a ref so the key handler never re-registers mid-preview.
  const previewListRef = useRef<string[]>([]);
  previewListRef.current =
    sourceTab === "global" ? (visibleGlobal ?? []).map((shot) => shot.name) : (visibleRels ?? []);

  const stepPreview = useCallback((delta: -1 | 1) => {
    setPreview((current) =>
      current === null ? null : mediaPreviewStep(previewListRef.current, current, delta),
    );
  }, []);

  // The preview is a layer of its own: the shared Escape stack closes it first, then a host modal on the next press.
  useEscapeClose(() => setPreview(null), previewOpen);
  // Keyed on open/closed, not on the file: stepping must not bounce focus back to the opener.
  useEffect(() => {
    if (!previewOpen) return;
    previewReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() =>
      previewCloseRef.current?.focus({ preventScroll: true }),
    );
    return () => {
      window.cancelAnimationFrame(frame);
      const target = previewReturnFocusRef.current;
      previewReturnFocusRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [previewOpen]);

  // Arrows step files while the scoped preview is open. Capture on window, so neither App's transport keys nor VideoPlayer's frame step (both bubble-phase window listeners) ever see them.
  useEffect(() => {
    if (!inspectorPreview || !previewOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // The overlay covers the panel, not the window: a field elsewhere keeps its arrows.
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      event.preventDefault();
      event.stopPropagation();
      stepPreview(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inspectorPreview, previewOpen, stepPreview]);

  const sourceRow = globalToggle ? (
    <SegmentedRow
      ariaLabel="Media source"
      options={[
        {
          value: "project",
          label: "Project",
          icon: <ProjectIcon />,
          title: "This project's assets",
        },
        {
          value: "global",
          label: "Library",
          icon: <LibraryIcon />,
          title: "Your media library; picking copies the file into this project",
        },
      ]}
      value={sourceTab}
      disabled={pickBusy}
      onChange={(tab) => {
        setSourceTab(tab);
        setPreview(null);
      }}
    />
  ) : null;
  const kindRow = kindToggle ? (
    <SegmentedRow
      ariaLabel="Media type"
      options={[
        { value: "video", label: "Video", icon: <VideoIcon /> },
        { value: "image", label: "Images", icon: <ImageIcon /> },
      ]}
      value={kindTab}
      disabled={pickBusy}
      onChange={setKindTab}
    />
  ) : null;
  const addButton = hideAdd ? null : sourceTab === "global" ? (
    <AddGlobalScreenshotButton
      onImported={(names) => {
        refreshGlobal();
        // A library add stays on the Library tab, but the kind tab still follows the new file.
        const first = names[0];
        if (first && !kinds && kindToggle) setKindTab(kindOfRel(first));
      }}
    />
  ) : (
    <AddMediaButton slug={slug} kinds={kinds} onImported={refresh} />
  );
  // Library files live in ~/Kookaburra Cut/screenshots and have their own per-card Delete.
  const cleanupButton =
    !cleanupUnused || sourceTab !== "project" ? null : cleanupUnused === "menu" ? (
      <button
        type="button"
        className="media-browser-more"
        aria-label={MEDIA_ACTIONS_MENU}
        title={MEDIA_ACTIONS_MENU}
        aria-haspopup="menu"
        aria-expanded={menu?.ariaLabel === MEDIA_ACTIONS_MENU}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: r.left,
            y: r.bottom + 4,
            ariaLabel: MEDIA_ACTIONS_MENU,
            returnFocus: e.currentTarget,
            // The sheet owns the selection and the confirm, so the item itself stays a plain open.
            items: [
              {
                id: "delete-unused",
                label: "Delete unused…",
                icon: <SceneMenuIcon id="delete" />,
                onSelect: () => setUnusedOpen(true),
              },
            ],
          });
        }}
      >
        <MoreIcon />
      </button>
    ) : (
      <button
        type="button"
        className="btn media-browser-cleanup"
        onClick={() => setUnusedOpen(true)}
      >
        Delete unused…
      </button>
    );

  const body = (
    <>
      {((!(sourceRow && kindRow) && sourceRow) ||
        kindRow ||
        hint ||
        addButton ||
        cleanupButton) && (
        <div className="media-browser-bar">
          <div className="media-browser-toggles">
            {!(sourceRow && kindRow) && sourceRow}
            {kindRow}
            {hint && <span className="muted media-browser-hint">{hint}</span>}
          </div>
          {(cleanupButton || addButton) && (
            <div className="media-browser-actions">
              {cleanupButton}
              {addButton}
            </div>
          )}
        </div>
      )}
      {pickError && <MediaBrowserError message={pickError} />}

      {sourceTab === "global" ? (
        globalShots === null || visibleGlobal === undefined ? (
          <p className="muted">Reading your library…</p>
        ) : globalShots.length === 0 ? (
          <p className="muted">
            Nothing in your library yet: add some here, or use "Add to library" on any project's
            media card.
          </p>
        ) : visibleGlobal.length === 0 ? (
          <p className="muted">
            {allowedKinds?.includes("image")
              ? "No images in your library yet."
              : "No videos in your library yet."}
          </p>
        ) : (
          <div className="media-grid">
            {visibleGlobal.map((shot) => (
              <MediaCard
                key={shot.name}
                rel={shot.name}
                meta={globalMetas[shot.name] ?? null}
                metaFailed={globalFailed.has(shot.name)}
                edited={false}
                canDrag={false}
                selected={false}
                disabled={pickBusy}
                onMenu={(x, y) =>
                  setMenu({
                    x,
                    y,
                    items: withPathItems(
                      [
                        {
                          id: "delete",
                          label: "Delete",
                          confirmLabel: "Really delete?",
                          danger: true,
                          title: "Moves the file to the Trash (projects keep their own copies)",
                          onSelect: () => {
                            setPickError(null);
                            deleteGlobalScreenshot(shot.name)
                              .then(refreshGlobal)
                              .catch((e) => setPickError(`Couldn't delete: ${String(e)}`));
                          },
                        },
                      ],
                      shot.absPath,
                      setPickError,
                    ),
                  })
                }
                onPreview={() => setPreview(shot.name)}
                onPick={onPick ? () => void pickGlobal(shot) : undefined}
              />
            ))}
          </div>
        )
      ) : rels === null ? (
        <p className="muted">Reading assets…</p>
      ) : rels.length === 0 ? (
        <p className="muted">
          Drop in footage, images or logos: everything stays on your Mac, inside this project's
          assets folder.
        </p>
      ) : visibleRels && visibleRels.length === 0 ? (
        <p className="muted">
          {allowedKinds?.includes("image")
            ? "No images in this project yet."
            : "No videos in this project yet."}
        </p>
      ) : (
        <div className="media-grid">
          {(visibleRels ?? []).map((rel) => (
            <MediaCard
              key={rel}
              rel={rel}
              meta={metas[rel] ?? null}
              metaFailed={metaFailed.has(rel)}
              edited={editNameOf(rel) !== null}
              canDrag={Boolean(draggableMedia && metas[rel])}
              selected={selectedRel != null && rel === selectedRel}
              disabled={pickBusy}
              onMenu={(x, y) =>
                setMenu({
                  x,
                  y,
                  items: withPathItems(
                    cardMenu
                      ? cardMenu(rel, metas[rel] ?? null, { editedOf: editNameOf(rel) })
                      : [],
                    `${projectPath}/${rel}`,
                    setPickError,
                  ),
                })
              }
              onPreview={() => setPreview(rel)}
              onPick={onPick ? () => onPick(rel, metas[rel] ?? null) : undefined}
            />
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className={`media-browser${compact ? " compact" : ""}`} aria-busy={pickBusy || undefined}>
      {sourceRow && kindRow ? <ToggleFieldset control={sourceRow}>{body}</ToggleFieldset> : body}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}

      {/* Portalled: an inspector drill page animates with a transform, which would become the containing block for the fixed overlay. */}
      {unusedOpen &&
        createPortal(
          <UnusedMediaSheet
            slug={slug}
            metas={metas}
            editedRels={editedRels}
            onDeleted={refresh}
            onClose={() => setUnusedOpen(false)}
          />,
          modalHost(),
        )}

      {preview && previewSrc && (
        <MediaPreviewOverlay
          name={preview}
          src={fsUrl(previewSrc)}
          kind={previewKind}
          fps={previewMeta?.fps}
          panel={inspectorPreview}
          canStep={previewListRef.current.length > 1}
          onStep={stepPreview}
          onClose={() => setPreview(null)}
          closeRef={previewCloseRef}
        />
      )}
    </div>
  );
}
