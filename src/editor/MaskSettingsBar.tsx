import type { EditMask, EditMaskStyle } from "../engine/edit";
import { DEFAULT_MASK_COLOR, DEFAULT_MASK_STRENGTH } from "../engine/editMasks";
import { ColourPicker } from "../ui/colour/ColourPicker";
import { normaliseHex } from "../ui/colour/colourUtils";
import { ToolIcon } from "./ToolIcon";

/** The mask strip under the topbar (the tap strip's pattern): the selected mask's style, its strength or colour, its keys at the playhead and delete; with the tool armed and nothing selected, a hint for drawing. */

const STYLES: { id: EditMaskStyle; label: string; title: string }[] = [
  {
    id: "solid",
    label: "Solid",
    title: "An opaque fill: the only style that can't be undone by anyone",
  },
  { id: "blur", label: "Blur", title: "A strong blur of what's underneath" },
  { id: "pixelate", label: "Pixelate", title: "Mosaic blocks over what's underneath" },
];

export interface MaskKeyState {
  /** A key sits at the frame on screen. */
  onKey: boolean;
  /** The frame on screen is inside the mask's span (keys can be added or removed here). */
  editable: boolean;
}

export function MaskSettingsBar({
  mask,
  image,
  keyState,
  onStyle,
  onStrength,
  onStrengthCommit,
  onColor,
  onAddKey,
  onRemoveKey,
  onDelete,
}: {
  mask: EditMask | null;
  /** The mask sits on a still: one static box, no keys. */
  image: boolean;
  keyState: MaskKeyState;
  onStyle: (style: EditMaskStyle) => void;
  onStrength: (strength: number) => void;
  onStrengthCommit: () => void;
  onColor: (hex: string | undefined) => void;
  onAddKey: () => void;
  onRemoveKey: () => void;
  onDelete: () => void;
}) {
  if (!mask) {
    return (
      <div className="tap-settings mask-settings">
        <span className="mask-settings-hint">
          Drag over the preview to hide an area (a click places a default box). New masks are solid
          black and cover the next 3 seconds.
        </span>
      </div>
    );
  }
  const strength = mask.strength ?? DEFAULT_MASK_STRENGTH;
  const why = !keyState.editable
    ? image
      ? "A mask on a still is one static box"
      : "Move the playhead into this mask's span first"
    : undefined;
  return (
    <div className="tap-settings mask-settings">
      <div className="tap-settings-scope" title="Mask style">
        {STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`tap-settings-seg${mask.style === s.id ? " selected" : ""}`}
            aria-pressed={mask.style === s.id}
            title={s.title}
            onClick={() => onStyle(s.id)}
          >
            <ToolIcon id={s.id} />
            {s.label}
          </button>
        ))}
      </div>
      {mask.style === "solid" ? (
        <ColourPicker
          value={mask.color ?? DEFAULT_MASK_COLOR}
          label="Mask colour"
          defaultValue={DEFAULT_MASK_COLOR}
          onReset={mask.color ? () => onColor(undefined) : undefined}
          onCommit={(hex) => {
            const next = normaliseHex(hex);
            if (next) onColor(next);
          }}
        />
      ) : (
        <label
          className="tap-settings-size"
          title={`Strength (${Math.round(strength * 100)}%); even the lowest setting hides typical UI text`}
        >
          <span className="tap-settings-size-label">Strength</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={strength}
            onChange={(e) => onStrength(Number(e.currentTarget.value))}
            onPointerUp={onStrengthCommit}
            onPointerCancel={onStrengthCommit}
            onKeyUp={onStrengthCommit}
            onBlur={onStrengthCommit}
          />
        </label>
      )}
      <button
        type="button"
        className="tap-settings-style-btn"
        disabled={!keyState.editable || keyState.onKey}
        title={
          why ??
          (keyState.onKey
            ? "A key already sits at this frame"
            : "Add a key here that holds the box where it is now (later drags only move what follows)")
        }
        onClick={onAddKey}
      >
        <ToolIcon id="addKey" />
        Add key
      </button>
      <button
        type="button"
        className="tap-settings-style-btn"
        disabled={!keyState.editable || !keyState.onKey || mask.keys.length <= 1}
        title={
          why ??
          (!keyState.onKey
            ? "No key at this frame"
            : mask.keys.length <= 1
              ? "A mask keeps at least one key"
              : "Delete the key at this frame")
        }
        onClick={onRemoveKey}
      >
        <ToolIcon id="deleteKey" />
        Delete key
      </button>
      <button
        type="button"
        className="tap-settings-style-btn"
        title="Delete this mask (⌫)"
        onClick={onDelete}
      >
        <ToolIcon id="delete" />
        Delete
      </button>
    </div>
  );
}
