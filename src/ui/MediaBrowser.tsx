import { listen } from "@tauri-apps/api/event";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatBytes } from "../engine/appCache";
import { useAssetRevision, withAssetRevision } from "../engine/assetRevisions";
import {
  type BrandImage,
  brandCategories,
  brandCategoryLabel,
  brandImageMeta,
  listBrandImages,
  useProjectBrand,
} from "../engine/brands";
import { listEdits } from "../engine/edit";
import {
  applyConformProgress,
  CONFORM_PROGRESS_EVENT,
  type ConformJob,
  type ConformProgress,
  type ConformStatus,
  cancelConform,
  conformMedia,
  conformPercent,
  conformStatus,
  conformWasCancelled,
  deleteGlobalScreenshot,
  formatMediaDuration,
  fsUrl,
  type GlobalScreenshot,
  globalScreenshotMeta,
  importGlobalScreenshots,
  importMedia,
  listConformJobs,
  listGlobalScreenshots,
  listOriginals,
  listProjectMedia,
  MEDIA_DRAG_TYPE,
  type MediaMeta,
  mediaMeta,
  mediaUsers,
  type OriginalFile,
  originalOfClip,
  pendingConformMeta,
  type RemovedOriginals,
  removableOriginals,
  removeOriginal,
  removeOriginals,
  revealPath,
} from "../engine/media";
import { projectIdForNativeSlug } from "../engine/project";
import { BrandCategoryIcon } from "./brandIcons";
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
  return beforeDanger(items, path);
}

/** Slot `extra` just above the first danger item, so Delete stays last. */
function beforeDanger(items: ContextMenuItem[], extra: ContextMenuItem[]): ContextMenuItem[] {
  const at = items.findIndex((it) => it.danger);
  return at < 0 ? [...items, ...extra] : [...items.slice(0, at), ...extra, ...items.slice(at)];
}

const CONFORM_REASONS: Record<string, string> = {
  vfr: "variable frame rate",
  "edit-list": "trimmed edit list",
  "b-frames": "reordered frames",
  primaries: "wide colour (P3)",
  decoders: "decoders disagree",
};

/** The "Needs conform" chip's tooltip: what the probe found, in words. */
export function conformReasonText(status: Pick<ConformStatus, "why">): string {
  const words = status.why.map((why) => CONFORM_REASONS[why] ?? why);
  return words.length > 0
    ? `Needs conform: ${words.join(", ")}. Conform from the ⋯ menu.`
    : "Needs conform";
}

function ConformIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13 6.5A5 5 0 0 0 3.6 4.6M3 9.5a5 5 0 0 0 9.4 1.9M3.4 2.4v2.4h2.4M12.6 13.6v-2.4h-2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.75" fill="currentColor" />
    </svg>
  );
}

/** The payload a media card drags: its project-relative path, the final one for a clip still conforming. */
export function mediaDragData(rel: string): [type: string, value: string][] {
  return [
    [MEDIA_DRAG_TYPE, rel],
    ["text/plain", rel],
  ];
}

/** A conform's card and queue state: its percent, or waiting for a background slot. */
export function conformCardState(job: Pick<ConformJob, "frame" | "total">): number | "waiting" {
  return job.total > 0 ? conformPercent(job) : "waiting";
}

function fileName(rel: string): string {
  return rel.split("/").pop() ?? rel;
}

/** The single Remove original confirmation. */
export function removeOriginalMessage(clipRel: string, bytes: number): string {
  return `Remove the original of ${fileName(clipRel)} (${formatBytes(bytes)})? The conformed clip stays.`;
}

/** The library ⋯ item, with what it frees. */
export function removeOriginalsLabel(bytes: number): string {
  return `Remove originals (${formatBytes(bytes)})…`;
}

/** The bulk confirmation; originals still in use are named as staying. */
export function removeOriginalsMessage(originals: readonly OriginalFile[]): string {
  const { count, bytes } = removableOriginals(originals);
  const kept = originals.length - count;
  const what = count === 1 ? "the original" : `${count} originals`;
  const stays = kept > 0 ? ` ${kept} still in use ${kept === 1 ? "stays" : "stay"}.` : "";
  return `Move ${what} (${formatBytes(bytes)}) to the Trash? The conformed clips stay.${stays}`;
}

/** What stopping a conform leaves: an import already placed somewhere comes back under the name it was placed with. */
export function stopConformNote(users: number): string {
  return users > 0
    ? `it's used in ${users} ${users === 1 ? "place" : "places"}, so the original comes back under this name, flagged Needs conform`
    : "the original is added as it is";
}

/** A conforming card's ⋯ menu: the host's primary action (placing works now), Copy path, and a confirmed Stop conforming. Edit, Add to library and Delete wait for the file. */
export function pendingCardItems(
  host: readonly ContextMenuItem[],
  absPath: string,
  onCancel: () => void,
  users = 0,
): ContextMenuItem[] {
  return [
    ...host.filter((item) => item.id === "primary"),
    {
      id: "copy-path",
      label: "Copy path",
      onSelect: () => void navigator.clipboard?.writeText(absPath),
    },
    {
      id: "cancel-conform",
      label: "Stop conforming",
      icon: <StopIcon />,
      confirmLabel: "Really stop?",
      title: `Stops the conform; ${stopConformNote(users)}`,
      onSelect: onCancel,
    },
  ];
}

/** A conformed clip's Remove original item: opens the confirmation, or explains why it can't run yet. */
export function removeOriginalItem(
  original: OriginalFile,
  clip: string,
  open: (target: { kind: "one"; original: OriginalFile; clip: string }) => void,
): ContextMenuItem {
  return {
    id: "remove-original",
    label: "Remove original…",
    icon: <SceneMenuIcon id="delete" />,
    disabled: original.busy !== null,
    title:
      original.busy ??
      `Move the original (${formatBytes(original.bytes)}) to the Trash; this clip stays`,
    onSelect: () => open({ kind: "one", original, clip }),
  };
}

/** A mezzanine still being written, as a full card: the original's poster and size under the final path, so it can be picked, dragged or menued like a finished clip while the conform runs. */
export function ConformingCard({
  job,
  meta,
  canDrag,
  selected,
  onMenu,
  onPreview,
  onPick,
  disabled,
}: {
  job: ConformJob;
  /** Read off the original (`pendingConformMeta`); null until it lands. */
  meta: MediaMeta | null;
  canDrag: boolean;
  selected: boolean;
  onMenu?: (x: number, y: number) => void;
  onPreview: () => void;
  onPick?: () => void;
  disabled?: boolean;
}) {
  return (
    <MediaCard
      rel={job.rel}
      meta={meta}
      metaFailed={false}
      edited={false}
      conforming={conformCardState(job)}
      canDrag={canDrag && meta !== null}
      selected={selected}
      onMenu={onMenu}
      onPreview={onPreview}
      onPick={onPick}
      disabled={disabled}
    />
  );
}

const QUEUE_STYLE = {
  flex: "0 0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  background: "var(--surface-raised)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
} as const;

const QUEUE_NAME_STYLE = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-xs)",
} as const;

const QUEUE_PERCENT_STYLE = {
  flex: "none",
  minWidth: "3.5em",
  textAlign: "right",
  fontSize: "var(--text-2xs)",
  fontVariantNumeric: "tabular-nums",
} as const;

/** The queue's heading: how many run and how many wait for a slot. */
export function conformQueueHeading(jobs: readonly ConformJob[]): string {
  const waiting = jobs.filter((job) => job.total === 0).length;
  const videos = jobs.length === 1 ? "1 video" : `${jobs.length} videos`;
  return `Conforming ${videos}${waiting > 0 && waiting < jobs.length ? `, ${waiting} waiting` : ""}`;
}

/** The conform queue above the grid: every job in start order with its progress and a two-step stop (the first press arms, a second within 3 s stops). */
export function ConformQueue({
  jobs,
  armed,
  onCancel,
  usedBy = {},
}: {
  jobs: readonly ConformJob[];
  /** The rel whose stop is armed, else null. */
  armed: string | null;
  onCancel: (rel: string) => void;
  /** How many project files already use each pending rel. */
  usedBy?: Readonly<Record<string, number>>;
}) {
  if (jobs.length === 0) return null;
  return (
    <section aria-label="Conform queue" style={QUEUE_STYLE}>
      <span
        className="muted"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontSize: "var(--text-2xs)",
        }}
      >
        <ConformIcon />
        {conformQueueHeading(jobs)}
      </span>
      <ol
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          margin: 0,
          padding: 0,
          listStyle: "none",
        }}
      >
        {jobs.map((job) => {
          const name = fileName(job.rel);
          const state = conformCardState(job);
          const isArmed = armed === job.rel;
          return (
            <li
              key={`${job.slug}:${job.rel}`}
              style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}
            >
              <span title={name} style={QUEUE_NAME_STYLE}>
                {name}
              </span>
              <span
                className="stage-busy-progress"
                role="progressbar"
                aria-label={`${name} conform progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={state === "waiting" ? undefined : state}
                style={{ flex: "none" }}
              >
                <span
                  className="stage-busy-progress-bar"
                  style={{ width: `${state === "waiting" ? 0 : state}%` }}
                />
              </span>
              <span className="muted" style={QUEUE_PERCENT_STYLE}>
                {state === "waiting" ? "Waiting" : `${state}%`}
              </span>
              <button
                type="button"
                className="media-browser-more"
                aria-label={isArmed ? `Stop conforming ${name}` : `Cancel conforming ${name}`}
                title={
                  isArmed
                    ? `Press again to stop; ${stopConformNote(usedBy[job.rel] ?? 0)}`
                    : "Stop this conform"
                }
                style={
                  isArmed
                    ? {
                        width: "auto",
                        gap: "var(--space-1)",
                        padding: "0 var(--space-2)",
                        color: "var(--danger)",
                      }
                    : undefined
                }
                onClick={() => onCancel(job.rel)}
              >
                <StopIcon />
                {isArmed && <span style={{ fontSize: "var(--text-2xs)" }}>Stop?</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The Remove original(s) confirmation: what goes to the Trash, and that the conformed clips stay. */
export function RemoveOriginalsSheet({
  title,
  message,
  run,
  onDone,
  onClose,
}: {
  title: string;
  message: string;
  run: () => Promise<RemovedOriginals>;
  /** Something moved: the host re-scans. */
  onDone: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(onClose, !busy);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const removed = await run();
      if (removed.count > 0) onDone();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <div className="modal-title-row">
          <h2 className="modal-title">{title}</h2>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          />
        </div>
        <p className="modal-hint">{message}</p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "Moving…" : "Move to Trash"}
          </button>
        </div>
      </div>
    </div>
  );
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

function ScreenshotsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v5A1.5 1.5 0 0 1 12.5 11h-3v1.5H11V14H5v-1.5h1.5V11h-3A1.5 1.5 0 0 1 2 9.5v-5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function BrandTagIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 3a1 1 0 0 1 1-1h4.6a1 1 0 0 1 .7.3l5.4 5.4a1 1 0 0 1 0 1.4l-4.6 4.6a1 1 0 0 1-1.4 0L2.3 8.3A1 1 0 0 1 2 7.6V3Zm3 3.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z"
        fill="currentColor"
        fillRule="evenodd"
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
  /** Show a Project/Global source toggle: Global browses ~/Kookaburra Cut/screenshots (plus the open project's brand images, when it has a brand) and picking copies the file into this project's assets first (copy-on-use). */
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
  conforming = null,
  needsConform = null,
}: {
  rel: string;
  meta: MediaMeta | null;
  /** Preview/metadata generation failed, say so instead of "Preparing…" forever. */
  metaFailed: boolean;
  /** True for a rendered editor output whose edit document still exists. */
  edited: boolean;
  /** Percent done while a conform runs ("waiting" before it has a slot), else null. */
  conforming?: number | "waiting" | null;
  /** The "Needs conform" chip's tooltip when the probe flags this file, else null. */
  needsConform?: string | null;
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
          for (const [type, value] of mediaDragData(rel)) e.dataTransfer.setData(type, value);
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
        {!edited && conforming !== null && (
          <span className="media-badge">
            {conforming === "waiting" ? "Waiting to conform" : `Conforming… ${conforming}%`}
          </span>
        )}
        {!edited && conforming === null && needsConform && (
          // Above the card's activate button, so the reasons show on hover.
          <span className="media-badge" title={needsConform} style={{ zIndex: 2 }}>
            Needs conform
          </span>
        )}
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
  // The open project's brand images ride the Library tab as a second source.
  const brand = useProjectBrand(globalToggle ? slug : undefined);
  const brandSlug =
    brand && brand.imageCount > 0 && (!kinds || kinds.includes("image")) ? brand.slug : null;
  const [librarySource, setLibrarySource] = useState<"screenshots" | "brand">("screenshots");
  const showBrand = sourceTab === "global" && brandSlug !== null && librarySource === "brand";
  const [brandImages, setBrandImages] = useState<BrandImage[] | null>(null);
  /** The category chip; null shows every image. */
  const [brandCategory, setBrandCategory] = useState<string | null>(null);
  const [brandMetas, setBrandMetas] = useState<Record<string, MediaMeta>>({});
  const brandMetasRef = useRef(brandMetas);
  brandMetasRef.current = brandMetas;
  const [brandFailed, setBrandFailed] = useState<ReadonlySet<string>>(new Set());
  /** Copy-on-use failures must never be silent (the pick just wouldn't land). */
  const [pickError, setPickError] = useState<string | null>(null);
  const pickBusyRef = useRef(false);
  const [pickBusy, setPickBusy] = useState(false);
  const [unusedOpen, setUnusedOpen] = useState(false);
  /** Conform jobs in flight for this project (imports still landing, in-place conforms). */
  const [conformJobs, setConformJobs] = useState<ConformJob[]>([]);
  /** Probe verdicts by rel, keyed to the content sha they were read for. */
  const [verdicts, setVerdicts] = useState<Record<string, { sha: string; status: ConformStatus }>>(
    {},
  );
  /** Card metas for imports still conforming, read off their originals. */
  const [pendingMetas, setPendingMetas] = useState<Record<string, MediaMeta>>({});
  /** The project's kept originals, behind Remove original and Remove originals. */
  const [originals, setOriginals] = useState<OriginalFile[]>([]);
  /** The queue row whose stop is armed. */
  const [armedCancel, setArmedCancel] = useState<string | null>(null);
  /** The open Remove original(s) confirmation: one original, or every removable one. */
  const [removing, setRemoving] = useState<
    { kind: "one"; original: OriginalFile; clip: string } | { kind: "all" } | null
  >(null);

  // The visible kind set: a fixed `kinds` filter wins; else the toolbar toggle; else all.
  const allowedKinds = kinds ?? (kindToggle ? [kindTab] : null);
  const visibleRels = rels?.filter((rel) => !allowedKinds || allowedKinds.includes(kindOfRel(rel)));
  // The library grid honours the same kind filter, so an image-only picker never offers a video.
  const visibleGlobal = globalShots?.filter(
    (s) => !allowedKinds || allowedKinds.includes(kindOfRel(s.name)),
  );
  const visibleBrand = brandImages?.filter(
    (image) => brandCategory === null || image.category === brandCategory,
  );
  // Imports still conforming have no file yet, so they get cards of their own (always videos).
  const pendingJobs = conformJobs.filter((job) => !rels?.includes(job.rel));
  const visiblePending = !allowedKinds || allowedKinds.includes("video") ? pendingJobs : [];

  const refresh = useCallback(() => {
    listProjectMedia(slug)
      .then(setRels)
      .catch(() => setRels([]));
    // Edit documents, to map rendered outputs back to their edits.
    listEdits(slug)
      .then(setEdits)
      .catch(() => setEdits([]));
    listOriginals(slug)
      .then(setOriginals)
      .catch(() => setOriginals([]));
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

  // A brand switch starts its view over.
  useEffect(() => {
    void brandSlug;
    setBrandImages(null);
    setBrandMetas({});
    setBrandFailed(new Set());
    setBrandCategory(null);
  }, [brandSlug]);

  useEffect(() => {
    void refreshKey;
    if (!showBrand || !brandSlug) return;
    let cancelled = false;
    listBrandImages(brandSlug)
      .then((images) => {
        if (!cancelled) setBrandImages(images);
      })
      .catch((e) => {
        console.warn(`[media] brand images failed for ${brandSlug}:`, e);
        if (!cancelled) setBrandImages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [showBrand, brandSlug, refreshKey]);

  // Posters for the visible brand images only, one at a time through the shared media cache: a brand holds hundreds of multi-MB originals, so the grid never decodes them.
  useEffect(() => {
    if (!showBrand || !brandSlug || !brandImages) return;
    const wanted = brandImages.filter(
      (image) => brandCategory === null || image.category === brandCategory,
    );
    let cancelled = false;
    (async () => {
      for (const image of wanted) {
        if (cancelled) return;
        if (brandMetasRef.current[image.rel]) continue;
        try {
          const meta = await brandImageMeta(brandSlug, image.rel);
          if (cancelled) return;
          setBrandMetas((prev) => ({ ...prev, [image.rel]: meta }));
        } catch (e) {
          console.warn(`[media] brand image metadata failed for ${image.rel}:`, e);
          if (!cancelled) {
            setBrandFailed((prev) => (prev.has(image.rel) ? prev : new Set(prev).add(image.rel)));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showBrand, brandSlug, brandImages, brandCategory]);

  /** Copy-on-use for a brand image, the global screenshot contract. */
  const pickBrand = useCallback(
    async (image: BrandImage) => {
      if (!onPick) return;
      await runMediaPickSingleFlight(pickBusyRef, async () => {
        setPickBusy(true);
        setPickError(null);
        try {
          const [rel] = await importMedia(slug, [image.path]);
          if (rel) await onPick(rel, brandMetas[image.rel] ?? null);
        } catch (e) {
          console.warn(`[media] copy-on-use failed for ${image.rel}:`, e);
          setPickError(`Couldn't copy into the project: ${String(e)}`);
        } finally {
          setPickBusy(false);
        }
      });
    },
    [onPick, slug, brandMetas],
  );

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

  // Conform jobs: seeded on every scan, then followed live; a landed or failed job re-scans so its file (or the restored original) shows.
  useEffect(() => {
    void refreshKey;
    let cancelled = false;
    listConformJobs(slug)
      .then((jobs) => {
        if (!cancelled) setConformJobs(jobs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug, refreshKey]);

  useEffect(() => {
    const unlisten = listen<ConformProgress>(CONFORM_PROGRESS_EVENT, (e) => {
      const event = e.payload;
      if (event.slug !== slug) return;
      setConformJobs((prev) => applyConformProgress(prev, event));
      if (event.stage !== "done" && event.stage !== "failed") return;
      setVerdicts((prev) => {
        if (!(event.rel in prev)) return prev;
        const next = { ...prev };
        delete next[event.rel];
        return next;
      });
      setPendingMetas((prev) => {
        if (!(event.rel in prev)) return prev;
        const next = { ...prev };
        delete next[event.rel];
        return next;
      });
      setArmedCancel((armed) => (armed === event.rel ? null : armed));
      if (event.stage === "failed" && !conformWasCancelled(event)) {
        const name = event.rel.replace(/^assets\//, "");
        setPickError(`Couldn't conform ${name}: ${event.error ?? "unknown error"}`);
      }
      refresh();
      // Re-read the list too: a scan that raced this event could have brought the finished job back.
      listConformJobs(slug)
        .then(setConformJobs)
        .catch(() => {});
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [slug, refresh]);

  // Verdict pass behind the "Needs conform" chip, one video at a time once its sha is known; cached natively by content sha, so a re-scan costs a lookup.
  const verdictsRef = useRef(verdicts);
  verdictsRef.current = verdicts;
  useEffect(() => {
    if (!rels) return;
    let cancelled = false;
    (async () => {
      for (const rel of rels) {
        if (cancelled) return;
        const meta = metas[rel];
        if (meta?.kind !== "video" || verdictsRef.current[rel]?.sha === meta.sha) continue;
        try {
          const status = await conformStatus(slug, rel, meta.sha);
          if (cancelled) return;
          setVerdicts((prev) => ({ ...prev, [rel]: { sha: meta.sha, status } }));
        } catch (e) {
          console.warn(`[media] conform probe failed for ${rel}:`, e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rels, metas, slug]);

  // Poster and size for each import still conforming, read off its original, so its card can be placed now.
  const pendingKey = JSON.stringify(pendingJobs.map((job) => [job.rel, job.original]));
  const pendingMetasRef = useRef(pendingMetas);
  pendingMetasRef.current = pendingMetas;
  useEffect(() => {
    const jobs = (JSON.parse(pendingKey) as [string, string][]).map(([rel, original]) => ({
      rel,
      original,
    }));
    if (jobs.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const job of jobs) {
        if (cancelled) return;
        if (pendingMetasRef.current[job.rel]) continue;
        try {
          const meta = await pendingConformMeta(slug, job);
          if (!cancelled) setPendingMetas((prev) => ({ ...prev, [job.rel]: meta }));
        } catch (e) {
          console.warn(`[media] no card for conforming ${job.rel}:`, e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingKey, slug]);

  const conformJobFor = useCallback(
    (rel: string) => conformJobs.find((job) => job.rel === rel) ?? null,
    [conformJobs],
  );

  // A queue stop is two presses: the first arms the row, which disarms itself after 3 s.
  useEffect(() => {
    if (armedCancel === null) return;
    const timer = window.setTimeout(() => setArmedCancel(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armedCancel]);

  const [stopUsers, setStopUsers] = useState<Record<string, number>>({});
  const cancelJob = useCallback(
    (rel: string) => {
      if (armedCancel !== rel) {
        setArmedCancel(rel);
        mediaUsers(slug, rel)
          .then((files) => setStopUsers((prev) => ({ ...prev, [rel]: files.length })))
          .catch(() => {});
        return;
      }
      setArmedCancel(null);
      setPickError(null);
      cancelConform(slug, rel).catch((e) => setPickError(`Couldn't stop conforming: ${String(e)}`));
    },
    [armedCancel, slug],
  );

  const startConform = useCallback(
    (rel: string) => {
      setPickError(null);
      conformMedia(slug, rel)
        .then(() =>
          setConformJobs((prev) =>
            applyConformProgress(prev, {
              slug,
              rel,
              stage: "queued",
              frame: 0,
              total: 0,
              error: null,
            }),
          ),
        )
        .catch((e) => setPickError(`Couldn't conform: ${String(e)}`));
    },
    [slug],
  );

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
  // A clip still conforming previews its original, the file that exists.
  const previewPending =
    preview && sourceTab === "project" ? pendingJobs.find((job) => job.rel === preview) : undefined;
  const previewMeta = preview
    ? ((showBrand
        ? brandMetas[preview]
        : sourceTab === "global"
          ? globalMetas[preview]
          : (metas[preview] ?? pendingMetas[preview])) ?? null)
    : null;
  const previewSrc = preview
    ? showBrand
      ? (brandImages?.find((image) => image.rel === preview)?.path ?? null)
      : sourceTab === "global"
        ? (globalShots?.find((s) => s.name === preview)?.absPath ?? null)
        : `${projectPath}/${previewPending?.original || preview}`
    : null;
  // A file replaced in place previews at its new revision.
  const previewRevision = useAssetRevision(
    sourceTab === "project" ? projectIdForNativeSlug(slug) : null,
    preview,
  );
  // Metadata streams in one file at a time, so a freshly listed image has none yet: fall back to the extension rather than handing a PNG to the video player.
  const previewKind = preview ? (previewMeta?.kind ?? kindOfRel(preview)) : "image";

  // The grid as the user sees it (current filter, Rust's newest-first sort), for prev/next; a ref so the key handler never re-registers mid-preview.
  const previewListRef = useRef<string[]>([]);
  previewListRef.current = showBrand
    ? (visibleBrand ?? []).map((image) => image.rel)
    : sourceTab === "global"
      ? (visibleGlobal ?? []).map((shot) => shot.name)
      : (visibleRels ?? []);

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
      value={showBrand ? "image" : kindTab}
      disabled={pickBusy || showBrand}
      onChange={setKindTab}
    />
  ) : null;
  const libraryRow =
    sourceTab === "global" && brand && brandSlug ? (
      <SegmentedRow
        ariaLabel="Library source"
        options={[
          {
            value: "screenshots",
            label: "Screenshots",
            icon: <ScreenshotsIcon />,
            title: "Your media library folder",
          },
          {
            value: "brand",
            label: brand.name,
            icon: <BrandTagIcon />,
            title: `${brand.name} brand images; picking copies the file into this project`,
          },
        ]}
        value={librarySource}
        disabled={pickBusy}
        onChange={(next) => {
          setLibrarySource(next);
          setPreview(null);
        }}
      />
    ) : null;
  const brandChips =
    showBrand && brandImages && brandImages.length > 0 ? (
      <fieldset className="group-chips media-brand-chips" aria-label="Brand image category">
        {[null, ...brandCategories(brandImages)].map((category) => (
          <button
            key={category ?? "all"}
            type="button"
            className={`btn btn-small chip-with-icon${brandCategory === category ? " selected" : ""}`}
            aria-pressed={brandCategory === category}
            disabled={pickBusy}
            onClick={() => {
              setBrandCategory(category);
              setPreview(null);
            }}
          >
            <BrandCategoryIcon category={category} />
            {category === null ? "All" : brandCategoryLabel(category)}
          </button>
        ))}
      </fieldset>
    ) : null;
  const addButton =
    hideAdd || showBrand ? null : sourceTab === "global" ? (
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
  const managing = Boolean(cleanupUnused) && sourceTab === "project";
  const freeOriginals = removableOriginals(originals);
  // The sheets own the selection and the confirm, so the items themselves stay plain opens.
  const actionItems: ContextMenuItem[] = [
    ...(cleanupUnused === "menu"
      ? [
          {
            id: "delete-unused",
            label: "Delete unused…",
            icon: <SceneMenuIcon id="delete" />,
            onSelect: () => setUnusedOpen(true),
          },
        ]
      : []),
    ...(freeOriginals.count > 0
      ? [
          {
            id: "remove-originals",
            label: removeOriginalsLabel(freeOriginals.bytes),
            icon: <SceneMenuIcon id="delete" />,
            title: "Move the originals kept beside conformed clips to the Trash",
            onSelect: () => setRemoving({ kind: "all" }),
          },
        ]
      : []),
  ];
  const actionsButton =
    managing && actionItems.length > 0 ? (
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
            items: actionItems,
          });
        }}
      >
        <MoreIcon />
      </button>
    ) : null;
  const cleanupButton =
    managing && cleanupUnused === true ? (
      <button
        type="button"
        className="btn media-browser-cleanup"
        onClick={() => setUnusedOpen(true)}
      >
        Delete unused…
      </button>
    ) : null;

  const body = (
    <>
      {((!(sourceRow && kindRow) && sourceRow) ||
        kindRow ||
        libraryRow ||
        hint ||
        addButton ||
        cleanupButton ||
        actionsButton) && (
        <div className="media-browser-bar">
          <div className="media-browser-toggles">
            {!(sourceRow && kindRow) && sourceRow}
            {kindRow}
            {libraryRow}
            {hint && <span className="muted media-browser-hint">{hint}</span>}
          </div>
          {(cleanupButton || actionsButton || addButton) && (
            <div className="media-browser-actions">
              {actionsButton}
              {cleanupButton}
              {addButton}
            </div>
          )}
        </div>
      )}
      {pickError && <MediaBrowserError message={pickError} />}
      {sourceTab === "project" && (!allowedKinds || allowedKinds.includes("video")) && (
        <ConformQueue
          jobs={conformJobs}
          armed={armedCancel}
          onCancel={cancelJob}
          usedBy={stopUsers}
        />
      )}

      {brandChips}
      {showBrand ? (
        brandImages === null || visibleBrand === undefined ? (
          <p className="muted">Reading brand images…</p>
        ) : visibleBrand.length === 0 ? (
          <p className="muted">No images in this brand yet.</p>
        ) : (
          <div className="media-grid">
            {visibleBrand.map((image) => (
              <MediaCard
                key={image.rel}
                rel={image.rel}
                meta={brandMetas[image.rel] ?? null}
                metaFailed={brandFailed.has(image.rel)}
                edited={false}
                canDrag={false}
                selected={false}
                disabled={pickBusy}
                onMenu={(x, y) =>
                  setMenu({
                    x,
                    y,
                    items: withPathItems(
                      onPick
                        ? []
                        : [
                            {
                              id: "add-to-project",
                              label: "Add to project",
                              title: "Copy into this project's assets",
                              onSelect: () => {
                                setPickError(null);
                                importMedia(slug, [image.path]).catch((e) =>
                                  setPickError(`Couldn't copy into the project: ${String(e)}`),
                                );
                              },
                            },
                          ],
                      image.path,
                      setPickError,
                    ),
                  })
                }
                onPreview={() => setPreview(image.rel)}
                onPick={onPick ? () => void pickBrand(image) : undefined}
              />
            ))}
          </div>
        )
      ) : sourceTab === "global" ? (
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
      ) : rels.length === 0 && pendingJobs.length === 0 ? (
        <p className="muted">
          Drop in footage, images or logos: everything stays on your Mac, inside this project's
          assets folder.
        </p>
      ) : visibleRels && visibleRels.length === 0 && visiblePending.length === 0 ? (
        <p className="muted">
          {allowedKinds?.includes("image")
            ? "No images in this project yet."
            : "No videos in this project yet."}
        </p>
      ) : (
        <div className="media-grid">
          {visiblePending.map((job) => {
            const meta = pendingMetas[job.rel] ?? null;
            return (
              <ConformingCard
                key={`conforming:${job.rel}`}
                job={job}
                meta={meta}
                canDrag={Boolean(draggableMedia)}
                selected={selectedRel != null && job.rel === selectedRel}
                disabled={pickBusy}
                onMenu={(x, y) => {
                  void mediaUsers(slug, job.rel)
                    .catch(() => [] as string[])
                    .then((files) =>
                      setMenu({
                        x,
                        y,
                        items: pendingCardItems(
                          cardMenu ? cardMenu(job.rel, meta, { editedOf: null }) : [],
                          `${projectPath}/${job.rel}`,
                          () => {
                            setPickError(null);
                            cancelConform(slug, job.rel).catch((e) =>
                              setPickError(`Couldn't stop conforming: ${String(e)}`),
                            );
                          },
                          files.length,
                        ),
                      }),
                    );
                }}
                onPreview={() => setPreview(job.rel)}
                onPick={onPick ? () => onPick(job.rel, meta) : undefined}
              />
            );
          })}
          {(visibleRels ?? []).map((rel) => {
            const job = conformJobFor(rel);
            const status = verdicts[rel]?.status;
            const flagged = !job && status?.needsConform === true;
            const kept = job ? null : originalOfClip(originals, rel);
            return (
              <MediaCard
                key={rel}
                rel={rel}
                meta={metas[rel] ?? null}
                metaFailed={metaFailed.has(rel)}
                edited={editNameOf(rel) !== null}
                conforming={job ? conformPercent(job) : null}
                needsConform={flagged && status ? conformReasonText(status) : null}
                canDrag={Boolean(draggableMedia && metas[rel])}
                selected={selectedRel != null && rel === selectedRel}
                disabled={pickBusy}
                onMenu={(x, y) =>
                  setMenu({
                    x,
                    y,
                    items: withPathItems(
                      beforeDanger(
                        cardMenu
                          ? cardMenu(rel, metas[rel] ?? null, { editedOf: editNameOf(rel) })
                          : [],
                        [
                          ...(flagged
                            ? [
                                {
                                  id: "conform",
                                  label: "Conform",
                                  icon: <ConformIcon />,
                                  title:
                                    "Re-encode at a steady 60 fps with QuickTime's timing and colour; the original moves to assets/.originals",
                                  onSelect: () => startConform(rel),
                                },
                              ]
                            : []),
                          ...(kept ? [removeOriginalItem(kept, rel, setRemoving)] : []),
                        ],
                      ),
                      `${projectPath}/${rel}`,
                      setPickError,
                    ),
                  })
                }
                onPreview={() => setPreview(rel)}
                onPick={onPick ? () => onPick(rel, metas[rel] ?? null) : undefined}
              />
            );
          })}
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

      {removing &&
        createPortal(
          removing.kind === "one" ? (
            <RemoveOriginalsSheet
              title="Remove original"
              message={removeOriginalMessage(removing.clip, removing.original.bytes)}
              run={() => removeOriginal(slug, removing.clip)}
              onDone={refresh}
              onClose={() => setRemoving(null)}
            />
          ) : (
            <RemoveOriginalsSheet
              title="Remove originals"
              message={removeOriginalsMessage(originals)}
              run={() => removeOriginals(slug)}
              onDone={refresh}
              onClose={() => setRemoving(null)}
            />
          ),
          modalHost(),
        )}

      {preview && previewSrc && (
        <MediaPreviewOverlay
          name={preview}
          src={withAssetRevision(fsUrl(previewSrc), previewRevision)}
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
