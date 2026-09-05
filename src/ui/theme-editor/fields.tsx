import { type ReactNode, useEffect, useState } from "react";
import { ThemeEditorIcon, type ThemeEditorIconName } from "./icons";

/** The theme editor's form primitives: a labelled row, a text field, a numeric field that only commits a finite value, and an icon-led option group. Every option control carries its leading icon (design rule 10). */

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="theme-editor-section">
      <header className="theme-editor-section-head">
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export function Field({
  label,
  icon,
  hint,
  children,
}: {
  label: string;
  icon: ThemeEditorIconName;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="theme-editor-field">
      <span className="theme-editor-field-label">
        <ThemeEditorIcon name={icon} size={15} />
        {label}
      </span>
      <div className="theme-editor-field-control">{children}</div>
      {hint && <p className="theme-editor-field-hint">{hint}</p>}
    </div>
  );
}

export function TextField({
  value,
  onCommit,
  placeholder,
  label,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      type="text"
      className="modal-input"
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

/** A number field that never writes NaN: an unparseable entry snaps back to the committed value on blur, and `allowEmpty` lets a field clear its key entirely (order, card radius). */
export function NumberField({
  value,
  onCommit,
  label,
  min,
  max,
  step = 1,
  allowEmpty = false,
  suffix,
}: {
  value: number | null;
  onCommit: (next: number | null) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  allowEmpty?: boolean;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (allowEmpty) {
        setDraft("");
        if (value !== null) onCommit(null);
      } else {
        setDraft(value === null ? "" : String(value));
      }
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(value === null ? "" : String(value));
      return;
    }
    const clamped = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <span className="theme-editor-number">
      <input
        type="number"
        className="modal-input"
        value={draft}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") setDraft(value === null ? "" : String(value));
        }}
      />
      {suffix && <span className="theme-editor-number-suffix">{suffix}</span>}
    </span>
  );
}

export interface IconOption<T extends string> {
  id: T;
  label: string;
  icon: ThemeEditorIconName;
  title?: string;
}

export function IconOptions<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly IconOption<T>[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <fieldset className="theme-editor-options">
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          className={`chip chip-with-icon${value === option.id ? " selected" : ""}`}
          title={option.title}
          onClick={() => onChange(option.id)}
        >
          <ThemeEditorIcon name={option.icon} size={14} />
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

/** A select carrying a leading icon, for lists too long to chip out (category, easing). */
export function IconSelect({
  icon,
  value,
  onChange,
  options,
  label,
}: {
  icon: ThemeEditorIconName;
  value: string;
  onChange: (next: string) => void;
  options: readonly { id: string; label: string }[];
  label: string;
}) {
  return (
    <span className="theme-editor-select">
      <ThemeEditorIcon name={icon} size={14} />
      <select
        className="modal-input"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function IconToggle({
  icon,
  offIcon,
  label,
  checked,
  onChange,
}: {
  icon: ThemeEditorIconName;
  offIcon?: ThemeEditorIconName;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`chip chip-with-icon${checked ? " selected" : ""}`}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <ThemeEditorIcon name={checked ? icon : (offIcon ?? icon)} size={14} />
      {label}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  icon: ThemeEditorIconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn btn-small chip-with-icon${danger ? " danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      <ThemeEditorIcon name={icon} size={14} />
      {label}
    </button>
  );
}
