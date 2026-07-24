import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

/** Inspector building blocks: the action row (17px icon · 13px label · right value · ›; selected = accent-subtle wash + a 2px inset accent edge, never a full accent fill), the toggle row (label and description left, switch right) and the drill group (uppercase label over tight rows, wider gaps between groups); rendered from the pure models in ui/inspectorOptions.ts. */

const DRAG_THRESHOLD_PX = 4;

/** Horizontal drag-to-scrub gesture over a numeric input: a plain click still focuses for typing; a >4px drag scrubs (value tracks live, `onInput` previews each tick, one `onCommit` on release), Shift drags at 0.1x, clamped to min/max/step. The caller owns the input and its text state; `onText` pushes the formatted value there during a drag. Shared by NumberField and DurationRow. */
export function useDragScrub({
  value,
  decimals,
  onCommit,
  onInput,
  onText,
  inputRef,
  min,
  max,
  step,
  dragScale,
}: {
  value: number;
  decimals: number;
  onCommit: (n: number) => void;
  onInput?: (n: number) => void;
  onText: (s: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  min?: number;
  max?: number;
  step?: number;
  dragScale?: number;
}) {
  const [dragging, setDragging] = useState(false);
  const clampSnap = (n: number) => {
    let v = step ? Math.round(n / step) * step : Number(n.toFixed(decimals));
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };
  const changed = (v: number) => Math.abs(v - value) > 10 ** -decimals / 2;
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || document.activeElement === inputRef.current) return;
    const startX = e.clientX;
    const startValue = value;
    let moved = false;
    const at = (ev: PointerEvent) =>
      clampSnap(
        startValue +
          (ev.clientX - startX) * (dragScale ?? 10 ** -decimals) * (ev.shiftKey ? 0.1 : 1),
      );
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        inputRef.current?.blur();
      }
      ev.preventDefault();
      const v = at(ev);
      onText(v.toFixed(decimals));
      onInput?.(v);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moved) return; // a plain click: the input focuses for typing
      ev.preventDefault();
      setDragging(false);
      const v = at(ev);
      if (changed(v)) onCommit(v);
      else onText(value.toFixed(decimals));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return { dragging, onPointerDown, clampSnap, changed };
}

/** One numeric field: click to type (blur/Enter commit, Escape revert), or drag horizontally to scrub (ew-resize on hover). While dragging the value tracks live; `onInput` (when given) previews it history-less and `onCommit` records one entry on release. Shared by the Camera section, the device Rotation drill-in and the text style fields. */
export function NumberField({
  label,
  value,
  decimals,
  onCommit,
  onInput,
  min,
  max,
  step,
  dragScale,
}: {
  label: string;
  value: number;
  decimals: number;
  onCommit: (n: number) => void;
  /** Live tick while dragging (wire to a history-less write at the call site); omit for a local-only drag preview. */
  onInput?: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Value change per horizontal pixel (default: the field's finest unit); Shift drags at 0.1x. */
  dragScale?: number;
}) {
  const [text, setText] = useState(value.toFixed(decimals));
  const inputRef = useRef<HTMLInputElement>(null);
  const { dragging, onPointerDown, clampSnap, changed } = useDragScrub({
    value,
    decimals,
    onCommit,
    onInput,
    onText: setText,
    inputRef,
    min,
    max,
    step,
    dragScale,
  });
  // Mirror the prop unless the user is typing or mid-drag.
  useEffect(() => {
    if (!dragging && document.activeElement !== inputRef.current) setText(value.toFixed(decimals));
  }, [value, decimals, dragging]);

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(value.toFixed(decimals));
      return;
    }
    const v = clampSnap(n);
    if (changed(v)) onCommit(v);
    else setText(value.toFixed(decimals));
  };

  return (
    <label className={`inspector-pose-field${dragging ? " scrubbing" : ""}`}>
      <input
        ref={inputRef}
        className="modal-input inspector-num inspector-num-drag"
        value={text}
        inputMode="decimal"
        onPointerDown={onPointerDown}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(value.toFixed(decimals));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="inspector-pose-caption">{label}</span>
    </label>
  );
}

/** A detailed popover choice: icon, title and a plain-language description under it; the flat aspect-style items stay simple buttons. */
export function PopoverChoice({
  icon,
  label,
  description,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={`inspector-popover-item detailed${active ? " active" : ""}`}
      onClick={onClick}
    >
      <span className="popover-choice-icon">{icon}</span>
      <span className="popover-choice-text">
        <span className="popover-choice-label">{label}</span>
        <span className="popover-choice-desc">{description}</span>
      </span>
    </button>
  );
}

/** Icon glyphs lifted from the design prototype (20-viewBox stroke SVGs). */
export function RowIcon({ id }: { id: string }) {
  const paths: Record<string, ReactNode> = {
    media: (
      <>
        <rect x="3" y="4" width="14" height="12" rx="2" />
        <circle cx="8" cy="9" r="1.3" />
        <path d="M4 14l4-3 4 3 3-2" />
      </>
    ),
    scenes: (
      <>
        <rect x="3" y="3.5" width="14" height="5.5" rx="1.5" />
        <rect x="3" y="11" width="14" height="5.5" rx="1.5" />
      </>
    ),
    theme: <path d="M10 3s5 5.5 5 8.5a5 5 0 01-10 0C5 8.5 10 3 10 3z" />,
    appIcon: (
      <>
        <rect x="3.5" y="3.5" width="13" height="13" rx="3.5" />
        <circle cx="10" cy="10" r="2.4" />
      </>
    ),
    aspect: <rect x="3" y="6" width="14" height="8" rx="1.5" />,
    music: (
      <>
        <path d="M8 14V5l7-1.5V12" />
        <circle cx="6" cy="14.5" r="1.8" />
        <circle cx="13" cy="13" r="1.8" />
      </>
    ),
    playback: (
      <>
        <rect x="3" y="4" width="14" height="12" rx="2" />
        <path d="M8.5 7.5v5l4-2.5z" />
      </>
    ),
  };
  const glyph = paths[id];
  if (!glyph) return null;
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      className="action-row-chevron"
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M8 6l4 4-4 4" />
    </svg>
  );
}

export function ActionRow({
  icon,
  label,
  value,
  chevron = true,
  danger = false,
  selected = false,
  disabled = false,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  value?: string;
  chevron?: boolean;
  danger?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const interactive = !!onClick && !disabled;
  return (
    <button
      type="button"
      className={`action-row${selected ? " action-row-selected" : ""}${danger ? " action-row-danger" : ""}`}
      onClick={onClick}
      disabled={!interactive}
    >
      {icon && <span className="action-row-icon">{icon}</span>}
      <span className="action-row-label">{label}</span>
      {value && (
        <span className="action-row-value" title={value}>
          {value}
        </span>
      )}
      {chevron && <Chevron />}
    </button>
  );
}

/** Middle-truncates a file name so the distinguishing tail (dates, times, extension) stays visible. */
export function middleTruncate(name: string, max = 34): string {
  if (name.length <= max) return name;
  const tail = 14;
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}

/** One boolean setting: label left, plain-language description under it, switch right. The input is a real checkbox for focus and assistive tech; the track is painted from its checked state. */
export function ToggleRow({
  icon,
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className={`toggle-row${disabled ? " toggle-row-disabled" : ""}`}>
      {icon && <span className="toggle-row-icon">{icon}</span>}
      <span className="toggle-row-text">
        <span className="toggle-row-label">{label}</span>
        {description && <span className="toggle-row-desc">{description}</span>}
      </span>
      <span className="toggle-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-switch-track" aria-hidden="true">
          <span className="toggle-switch-thumb" />
        </span>
      </span>
    </label>
  );
}

/** A drill-in option group: uppercase label, optional group-level hint, rows sitting tight underneath; groups separate from their neighbours with a wider gap than rows do. */
export function DrillGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="drill-group">
      <span className="drill-group-label">{label}</span>
      {hint && <span className="drill-group-hint">{hint}</span>}
      {children}
    </div>
  );
}

/** The drill-in back bar: a full-width, eye-catching affordance at the top of every drill-in, accent wash, real hit area, "Back to <context>". */
export function DrillBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="inspector-drill-back" onClick={onClick}>
      <span className="inspector-drill-back-chev">
        <svg
          width="15"
          height="15"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M12 5l-5 5 5 5" />
        </svg>
      </span>
      {`Back to ${label}`}
    </button>
  );
}
