import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { listEdits } from "../engine/edit";
import {
  formatMediaDuration,
  fsUrl,
  importMedia,
  listProjectMedia,
  MEDIA_DRAG_TYPE,
  type MediaMeta,
  mediaMeta,
} from "../engine/media";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { useEscapeClose } from "./useEscapeClose";
import { VideoPlayer } from "./VideoPlayer";

/** The reusable project-media browser: a card grid of the open project's `assets/`, poster thumbnails, hover-scrub across ~10 pre-extracted frames, Edited chips, multi-file import and a fullscreen preview. Thumbnails generate lazily in the background, one file at a time, so a folder of long recordings never blocks the grid. The host owns the shell (main-window modal vs inspector drill-in vs editor side panel) and supplies the per-card ⋯/right-click menu via `cardMenu`, the only part that differs (2026-07-12: the old per-card button row overflowed). */

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm"];
const MEDIA_PICKER_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];

/** Kind by extension, instant (metas stream in later; the backend agrees on these). */
function kindOfRel(rel: string): "image" | "video" {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext) ? "image" : "video";
}

export interface MediaActionContext {
  /** The owning edit's name when this file is a rendered editor output, else null. */
  editedOf: string | null;
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
      {error && <span className="modal-error media-add-error">{error}</span>}
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

export interface MediaBrowserProps {
  slug: string;
  /** Absolute project folder, full-res previews load from it via the asset protocol. */
  projectPath: string;
  /** Bump to re-scan from outside (e.g. after a drag-drop import). */
  refreshKey?: number;
  /** Tighter grid for narrow hosts (the editor's side panel). */
  compact?: boolean;
  /** Video cards become HTML5-draggable (`MEDIA_DRAG_TYPE` carries the rel path). Editor-window only: the main window's native drag-drop interception eats these. */
  draggableVideos?: boolean;
  /** Small muted hint in the toolbar row (e.g. the drag affordance). */
  hint?: string;
  /** Restrict the browser to these kinds (e.g. background images). Filters the grid and the Add-media file picker; no toggle is shown. */
  kinds?: ("video" | "image")[];
  /** Show a Video/Images toggle in the toolbar, defaulting to video (Change media). */
  kindToggle?: boolean;
  /** Hide the built-in Add button: the host renders `<AddMediaButton>` in its own title row and bumps `refreshKey` on import. */
  hideAdd?: boolean;
  /** Per-card ⋯/right-click menu items; omit for none (the editor panel drags instead). The browser hosts one ContextMenu, the house two-step confirm rides `confirmLabel` (see ui/mediaCardMenu.tsx for the shared Edit/Insert/Delete set). */
  cardMenu?: (rel: string, meta: MediaMeta | null, ctx: MediaActionContext) => ContextMenuItem[];
  /** Highlight this rel as the current selection (e.g. the scene's background video). */
  selectedRel?: string | null;
  /** Single-select picker mode: clicking a card chooses it instead of opening the fullscreen preview (which moves to a per-card "Preview" action). Import-in-place and hover-scrub keep working; the wizard host advances on the callback. */
  onPick?: (rel: string, meta: MediaMeta | null) => void;
}

function MediaCard({
  rel,
  meta,
  metaFailed,
  edited,
  canDrag,
  selected,
  onMenu,
  onPreview,
  onPick,
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
}) {
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const name = rel.replace(/^assets\//, "");
  const activate = onPick ?? onPreview;
  const scrub =
    meta && scrubIndex !== null && meta.scrubPaths.length > 0
      ? meta.scrubPaths[Math.min(scrubIndex, meta.scrubPaths.length - 1)]
      : null;
  const imageSrc = scrub ?? meta?.posterPath ?? null;

  return (
    // The whole card is the click target: hover state + hand cursor; fullscreen preview moves to the expand icon over the thumb. Deliberately a <div role="button">, not a <button>: WKWebView treats <button> as a special replaced-element frame and won't reliably paint an <img> descendant (confirmed against WebKit).
    // biome-ignore lint/a11y/useSemanticElements: a real <button> drops the img in WKWebView
    <div
      className={`media-card${selected ? " selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={onPick ? `Use ${name}` : `Preview ${name}`}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) return;
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, rel);
        e.dataTransfer.setData("text/plain", rel);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={activate}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-scrub is decorative — the card root carries the button semantics */}
      <div
        ref={thumbRef}
        className="media-thumb"
        onMouseMove={(e) => {
          // Hover-scrub: cursor X sweeps across the pre-extracted frames.
          if (!meta || meta.scrubPaths.length === 0 || !thumbRef.current) return;
          const rect = thumbRef.current.getBoundingClientRect();
          const t = (e.clientX - rect.left) / Math.max(1, rect.width);
          setScrubIndex(
            Math.max(
              0,
              Math.min(meta.scrubPaths.length - 1, Math.floor(t * meta.scrubPaths.length)),
            ),
          );
        }}
        onMouseLeave={() => setScrubIndex(null)}
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
            onClick={(e) => {
              e.stopPropagation();
              onPreview();
            }}
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
        <div className="media-card-head">
          <span className="media-name" title={name}>
            {name}
          </span>
          {onMenu && (
            <button
              type="button"
              className="media-menu-btn"
              aria-label={`Actions for ${name}`}
              title="Actions"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                onMenu(r.left, r.bottom + 4);
              }}
            >
              ⋯
            </button>
          )}
        </div>
        <span className="media-meta-line">
          {meta
            ? meta.kind === "video"
              ? `${meta.width}×${meta.height} · ${meta.fps.toFixed(0)} fps`
              : `${meta.width}×${meta.height} · image`
            : "…"}
        </span>
      </div>
    </div>
  );
}

export function MediaBrowser({
  slug,
  projectPath,
  refreshKey = 0,
  compact,
  draggableVideos,
  hint,
  kinds,
  kindToggle,
  hideAdd,
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
  const [kindTab, setKindTab] = useState<"video" | "image">("video");

  // The visible kind set: a fixed `kinds` filter wins; else the toolbar toggle; else all.
  const allowedKinds = kinds ?? (kindToggle ? [kindTab] : null);
  const visibleRels = rels?.filter((rel) => !allowedKinds || allowedKinds.includes(kindOfRel(rel)));

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

  const previewMeta = preview ? (metas[preview] ?? null) : null;

  // The fullscreen preview is a layer of its own: the shared Escape stack closes it first, then a host modal on the next press.
  useEscapeClose(() => setPreview(null), preview !== null);

  return (
    <div className={`media-browser${compact ? " compact" : ""}`}>
      {(kindToggle || hint || !hideAdd) && (
        <div className={`media-browser-bar${kindToggle ? " centered" : ""}`}>
          {kindToggle && (
            <span className="wizard-presets">
              <button
                type="button"
                className={`chip chip-icon${kindTab === "video" ? " selected" : ""}`}
                onClick={() => setKindTab("video")}
              >
                <VideoIcon /> Video
              </button>
              <button
                type="button"
                className={`chip chip-icon${kindTab === "image" ? " selected" : ""}`}
                onClick={() => setKindTab("image")}
              >
                <ImageIcon /> Images
              </button>
            </span>
          )}
          {hint && <span className="muted media-browser-hint">{hint}</span>}
          {!hideAdd && <AddMediaButton slug={slug} kinds={kinds} onImported={refresh} />}
        </div>
      )}

      {rels === null ? (
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
              canDrag={Boolean(draggableVideos && metas[rel]?.kind === "video")}
              selected={selectedRel != null && rel === selectedRel}
              onMenu={
                cardMenu
                  ? (x, y) =>
                      setMenu({
                        x,
                        y,
                        items: cardMenu(rel, metas[rel] ?? null, { editedOf: editNameOf(rel) }),
                      })
                  : undefined
              }
              onPreview={() => setPreview(rel)}
              onPick={onPick ? () => onPick(rel, metas[rel] ?? null) : undefined}
            />
          ))}
        </div>
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}

      {preview && (
        <div className="media-preview" role="presentation">
          {/* Click-anywhere-to-close, as a real button so keyboards get it too. */}
          <button
            type="button"
            className="media-preview-backdrop"
            aria-label="Close preview"
            onClick={() => setPreview(null)}
          />
          {previewMeta?.kind === "image" ? (
            <img src={fsUrl(`${projectPath}/${preview}`)} alt={preview} />
          ) : (
            // Preview-only playback (never the export path); custom minimal controls.
            <VideoPlayer src={fsUrl(`${projectPath}/${preview}`)} fps={previewMeta?.fps} autoPlay />
          )}
          <button
            type="button"
            className="toast-close media-preview-close"
            aria-label="Close preview"
            onClick={() => setPreview(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
