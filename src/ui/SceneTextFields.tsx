import { useLayoutEffect, useRef, useState } from "react";
import { ColourPicker } from "./colour/ColourPicker";
import { MediaBrowser } from "./MediaBrowser";
import { useEscapeClose } from "./useEscapeClose";

/** Single-line textarea that grows with its content; no manual resize handle. */
export function AutoGrowTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the value is the re-measure trigger
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={1} className="modal-input wizard-autogrow" {...props} />;
}

/** Swatch wiring for a text field; absent means the field has no colour control. */
export interface TextFieldColour {
  /** Current fill, sRGB hex. */
  value: string;
  /** The reset target (the primitive's or theme's default fill). */
  defaultValue: string;
  onCommit: (hex: string) => void;
  onReset: () => void;
}

/** Common header emojis for app and product-release presentations; a pick replaces the icon field. */
export const HEADER_EMOJIS = [
  "🚀",
  "✨",
  "🎉",
  "🔥",
  "⚡",
  "🆕",
  "📢",
  "🎯",
  "🛠️",
  "🐛",
  "🔒",
  "💡",
  "⭐",
  "📦",
  "✅",
  "📈",
];

/** Header-icon field with the emoji quick-pick grid and an image picker, shared by the New-scene wizard and the Edit-text drill-in; the host owns the value/commit plumbing, the field owns its own picker modal (the ColourPicker pattern). */
export function HeaderIconField({
  value,
  selected,
  hint,
  slug,
  projectPath,
  onChange,
  onBlur,
  onPick,
}: {
  value: string;
  /** The committed icon, marking the active tile. */
  selected: string;
  hint: string;
  slug: string;
  /** Absolute project folder, for the image picker's previews. */
  projectPath: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** An emoji tile or image pick (commits instantly at the host). */
  onPick: (value: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  useEscapeClose(() => setPickerOpen(false), pickerOpen);
  return (
    <div className="wizard-field">
      <TextFieldRow
        label="Header icon"
        value={value}
        placeholder="an emoji or assets/icon.png"
        onChange={onChange}
        onBlur={onBlur}
      />
      <div className="chip-icon-grid">
        {HEADER_EMOJIS.map((e) => (
          <button
            key={e}
            type="button"
            title={e}
            className={`chip-icon-tile emoji${selected === e ? " selected" : ""}`}
            onClick={() => onPick(e)}
          >
            {e}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-left" onClick={() => setPickerOpen(true)}>
        Choose image…
      </button>
      <p className="modal-hint">{hint}</p>
      {pickerOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Choose an icon image"
        >
          <div className="modal wizard-wide media-modal-wide">
            <h2>Choose an icon image</h2>
            <div className="wizard-media-host">
              <MediaBrowser
                slug={slug}
                projectPath={projectPath}
                kinds={["image"]}
                globalToggle
                onPick={(rel) => {
                  setPickerOpen(false);
                  onPick(rel);
                }}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setPickerOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Labelled auto-grow text row with an optional colour swatch: the one scene-text field shared by the wizards and the Edit-text drill-in. */
export function TextFieldRow({
  label,
  value,
  placeholder,
  colour,
  onChange,
  onKeyDown,
  onBlur,
}: {
  label: string;
  value: string;
  placeholder?: string;
  colour?: TextFieldColour;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <div className="wizard-field">
      <span className={`wizard-label${colour ? " wizard-label-with-colour" : ""}`}>
        {label}
        {colour && (
          <ColourPicker
            value={colour.value}
            label={`${label} colour`}
            defaultValue={colour.defaultValue}
            onReset={colour.onReset}
            onCommit={colour.onCommit}
          />
        )}
      </span>
      <AutoGrowTextarea
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
    </div>
  );
}
