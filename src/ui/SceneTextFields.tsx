import { useLayoutEffect, useRef } from "react";
import { ColourPicker } from "./colour/ColourPicker";

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
