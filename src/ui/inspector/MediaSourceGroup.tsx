import type { Ref } from "react";
import { DrillGroup } from "./rows";

/** The one media source group: a thumbnail, the file name and a detail line over Change and Edit. The device Screen group and the media drill's Source group are the same surface, so they share this component and the `device-editor-media-*` styling seam. */

/** The thumbnail box for one source aspect, bounded on its long edge so a portrait screenshot reads as portrait. Undefined until the probe lands, which leaves the square placeholder. */
export function mediaThumbnailSize(
  aspectRatio?: number,
): { width: number; height: number } | undefined {
  if (typeof aspectRatio !== "number" || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return undefined;
  }
  const bound = 58;
  const round = (value: number) => Math.round(value * 100) / 100;
  return aspectRatio >= 1
    ? { width: bound, height: round(bound / aspectRatio) }
    : { width: round(bound * aspectRatio), height: bound };
}

export function MediaSourceIcon({ type }: { type: "media" | "edit" }) {
  const glyph = {
    media: (
      <>
        <rect x="3" y="4" width="14" height="12" rx="2" />
        <circle cx="8" cy="9" r="1.3" />
        <path d="m4 14 4-3 4 3 3-2" />
      </>
    ),
    edit: (
      <>
        <path d="M4 15.5 5 12l7.8-7.8 3 3L8 15z" />
        <path d="m11.6 5.4 3 3" />
      </>
    ),
  }[type];
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
      {glyph}
    </svg>
  );
}

export interface MediaSourceGroupProps {
  /** The group's own label: "Screen" on a device, the media kind in the media drill. */
  label: string;
  previewUrl?: string;
  aspectRatio?: number;
  name: string;
  detail: string;
  disabled?: boolean;
  /** Extra reason Edit cannot run, for example a source with no editor to open. */
  editDisabled?: boolean;
  changeButtonRef?: Ref<HTMLButtonElement>;
  onChange: () => void;
  onEdit?: () => void;
}

export function MediaSourceGroup({
  label,
  previewUrl,
  aspectRatio,
  name,
  detail,
  disabled = false,
  editDisabled = false,
  changeButtonRef,
  onChange,
  onEdit,
}: MediaSourceGroupProps) {
  const thumbnailSize = previewUrl ? mediaThumbnailSize(aspectRatio) : undefined;
  return (
    <DrillGroup label={label}>
      <div className="device-editor-media-summary">
        <div className="device-editor-media-thumb" style={thumbnailSize}>
          {previewUrl ? (
            <img src={previewUrl} alt="" draggable={false} />
          ) : (
            <MediaSourceIcon type="media" />
          )}
        </div>
        <div className="device-editor-media-copy">
          <span className="device-editor-media-name" title={name}>
            {name}
          </span>
          <span className="device-editor-media-detail">{detail}</span>
        </div>
      </div>
      <div className="device-editor-media-actions">
        <button
          ref={changeButtonRef}
          type="button"
          className="btn"
          disabled={disabled}
          onClick={onChange}
        >
          <MediaSourceIcon type="media" />
          Change
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled || editDisabled || !onEdit}
          onClick={() => onEdit?.()}
        >
          <MediaSourceIcon type="edit" />
          Edit
        </button>
      </div>
    </DrillGroup>
  );
}
