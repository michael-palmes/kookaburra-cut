import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { GizmoMode } from "../../engine/gizmoMode";
import type { ChartType } from "../../toolkit/chart/types";
import { DebouncedRange } from "../TextAnimationPicker";
import { isTypingIn } from "../textEditFocus";
import { useInspectorNavigation } from "./InspectorNavigationShell";

/** Inspector building blocks: the action row (17px icon · 13px label · right value · ›; selected = accent-subtle wash + a 2px inset accent edge, never a full accent fill), the toggle row (label and description left, switch right) and the drill group (uppercase label over tight rows, wider gaps between groups); rendered from the pure models in ui/inspectorOptions.ts. */

const DRAG_THRESHOLD_PX = 4;

/** Horizontal drag-to-scrub gesture over a numeric input: a plain click still focuses for typing; a >4px drag scrubs even while the input is focused (value tracks live, `onInput` previews each tick, one `onCommit` on release), Shift drags at 0.1x, clamped to min/max/step. The caller owns the input and its text state; `onText` pushes the value there during a drag, spelled by `format` when given and by `decimals` otherwise. Shared by NumberField and DurationRow. */
export function useDragScrub({
  value,
  decimals,
  onCommit,
  onInput,
  onText,
  format,
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
  /** How a scrubbed value is spelled into the field; omit for plain `toFixed(decimals)`. */
  format?: (n: number) => string;
  inputRef: RefObject<HTMLInputElement | null>;
  min?: number;
  max?: number;
  step?: number;
  dragScale?: number;
}) {
  const [dragging, setDragging] = useState(false);
  const write = format ?? ((n: number) => n.toFixed(decimals));
  const clampSnap = (n: number) => {
    let v = step ? Math.round(n / step) * step : Number(n.toFixed(decimals));
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };
  const changed = (v: number) => Math.abs(v - value) > 10 ** -decimals / 2;
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
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
        window.getSelection()?.removeAllRanges();
      }
      ev.preventDefault();
      const v = at(ev);
      onText(write(v));
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
      else onText(write(value));
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
  disabled = false,
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
  disabled?: boolean;
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
  // Mirror the prop unless the user is typing or mid-drag; a field that merely holds focus (after a drag, or a committed edit) still tracks the value, so an undo shows.
  useEffect(() => {
    if (!dragging && !isTypingIn(inputRef.current)) setText(value.toFixed(decimals));
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
        disabled={disabled}
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

export function InspectorSliderRow({
  icon,
  label,
  value,
  min,
  max,
  step,
  onCommit,
  onInput,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
  onInput?: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="popover-row inspector-slider-row">
      <span className="popover-inline slider-row-label">
        <span className="inspector-slider-row-icon">{icon}</span>
        {label}
      </span>
      <DebouncedRange
        value={value}
        min={min}
        max={max}
        step={step}
        label={label}
        disabled={disabled}
        onCommit={onCommit}
        onInput={onInput}
      />
    </div>
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
    typography: (
      <>
        <path d="M4 5.5V4h12v1.5" />
        <path d="M10 4v12" />
        <path d="M7.5 16h5" />
      </>
    ),
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
    render: (
      <>
        <circle cx="10" cy="10" r="7" />
        <path d="M11.62 7.2l4.02 6.96" />
        <path d="M8.38 7.2h8.04" />
        <path d="M6.77 10l4.02-6.96" />
        <path d="M8.38 12.8L4.37 5.84" />
        <path d="M11.62 12.8H3.58" />
        <path d="M13.23 10l-4.02 6.96" />
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

/** Chart-type glyphs, drawn from each type's own marks (bars, line, area, wedge) rather than art: ONE set shared by the chart inspector's type grid (18px) and the New-scene wizard's chips (14px), so a type never wears two faces. */
export function ChartTypeIcon({ id, size = 18 }: { id: ChartType; size?: number }) {
  const glyph = {
    column: <path d="M4 16V9M10 16V5M16 16v-4M3 16.5h14" />,
    stackedColumn: (
      <>
        <path d="M5 16v-4M5 12V8M13 16v-3M13 13V6" />
        <path d="M3 16.5h14" opacity="0.6" />
      </>
    ),
    bar: <path d="M4 4.5h7M4 9.5h11M4 14.5h5M3.5 3v13" />,
    stackedBar: (
      <>
        <path d="M4 5.5h5M9 5.5h5M4 12.5h4M8 12.5h7" />
        <path d="M3.5 3v13" opacity="0.6" />
      </>
    ),
    line: (
      <>
        <path d="M3.5 13.5l3.5-4 3 2.5 6.5-7" />
        <path d="M3 16.5h14" opacity="0.6" />
      </>
    ),
    area: (
      <>
        <path d="M3.5 13l3.5-4 3 2.5 6.5-6.5V15h-13z" fill="currentColor" opacity="0.28" />
        <path d="M3.5 13l3.5-4 3 2.5 6.5-6.5" />
      </>
    ),
    stackedArea: (
      <>
        <path d="M3.5 14l4-2 3 1.5 5.5-3V16h-12.5z" fill="currentColor" opacity="0.28" />
        <path d="M3.5 14l4-2 3 1.5 5.5-3" />
        <path d="M3.5 9.5l4-3 3 2 5.5-4" />
      </>
    ),
    pie: (
      <>
        <circle cx="10" cy="10" r="6.5" />
        <path d="M10 3.5v6.5h6.5" />
      </>
    ),
  }[id];
  return (
    <svg
      width={size}
      height={size}
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

/** Gizmo-mode pill icons (Move / Rotate / Scale), the SegmentedRow 13px size; shared by the object and chart placement drills. */
export function GizmoModeIcon({ mode }: { mode: GizmoMode }) {
  const glyph = {
    translate: (
      <>
        <path d="M10 3.5v13M3.5 10h13" />
        <path d="M8 5.5l2-2 2 2M8 14.5l2 2 2-2M5.5 8l-2 2 2 2M14.5 8l2 2-2 2" />
      </>
    ),
    rotate: (
      <>
        <path d="M16.2 10a6.2 6.2 0 11-1.9-4.5" />
        <path d="M16.6 2.6v3.2h-3.2" />
      </>
    ),
    scale: (
      <>
        <rect x="3.5" y="8.5" width="8" height="8" rx="1" />
        <path d="M11.5 8.5L16.5 3.5M16.5 7V3.5H13" />
      </>
    ),
  }[mode];
  return (
    <svg
      width="13"
      height="13"
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

/** One exclusive choice in a SegmentedRow; the optional icon leads the label (17px inline SVG, same treatment the camera subtabs shipped with). */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Tooltip; useful where the label alone undersells the consequence of switching. */
  title?: string;
  disabled?: boolean;
}

export function segmentedKeyTarget<T extends string>(
  options: readonly SegmentedOption<T>[],
  value: T,
  key: string,
): T | null {
  const enabledOptions = options.filter((option) => !option.disabled);
  if (enabledOptions.length === 0) return null;
  const current = Math.max(
    0,
    enabledOptions.findIndex((option) => option.value === value),
  );
  const nextIndex =
    key === "ArrowRight" || key === "ArrowDown"
      ? (current + 1) % enabledOptions.length
      : key === "ArrowLeft" || key === "ArrowUp"
        ? (current - 1 + enabledOptions.length) % enabledOptions.length
        : key === "Home"
          ? 0
          : key === "End"
            ? enabledOptions.length - 1
            : null;
  return nextIndex === null ? null : (enabledOptions[nextIndex]?.value ?? null);
}

/** The shared segmented toggle (the camera drill's subtabs, promoted): 2-5 exclusive options as one compact pill. Clicking the active option is a no-op. Pair with ToggleFieldset to straddle a bordered section's top edge. */
export function SegmentedRow<T extends string>({
  options,
  value,
  onChange,
  className,
  ariaLabel,
  disabled = false,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const selectedEnabled = options.some((option) => option.value === value && !option.disabled);
  const fallbackValue = options.find((option) => !option.disabled)?.value;

  return (
    <div
      className={className ? `inspector-subtabs ${className}` : "inspector-subtabs"}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: styled buttons implement the complete roving radio keyboard pattern
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={
            !disabled &&
            !o.disabled &&
            (o.value === value || (!selectedEnabled && o.value === fallbackValue))
              ? 0
              : -1
          }
          className={`inspector-subtab${o.value === value ? " active" : ""}`}
          title={o.title}
          disabled={disabled || o.disabled}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
          onKeyDown={(event) => {
            const next = segmentedKeyTarget(options, o.value, event.key);
            if (!next) return;
            event.preventDefault();
            if (next !== o.value) onChange(next);
            const index = options.findIndex((option) => option.value === next);
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
              .item(index)
              .focus();
          }}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A bordered section whose segmented control straddles the top edge, centred (the Camera drill treatment). `control` must be a SegmentedRow rendered as a direct child: the straddle CSS targets `.toggle-fieldset > .inspector-subtabs`. */
export function ToggleFieldset({ control, children }: { control: ReactNode; children: ReactNode }) {
  return (
    <div className="toggle-fieldset">
      {control}
      {children}
    </div>
  );
}

export function DrillBack({
  label,
  title,
  onClick,
  actions,
}: {
  label: string;
  title: string;
  onClick: () => void;
  actions?: ReactNode;
}) {
  const navigation = useInspectorNavigation();
  return (
    <div className="inspector-drill-header">
      <button
        type="button"
        className="inspector-drill-back"
        aria-label={`Back to ${label} from ${title}`}
        onClick={() => {
          if (navigation) navigation.requestBack(onClick);
          else onClick();
        }}
      >
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
        <span className="inspector-drill-destination">{label}</span>
        <span className="inspector-drill-current">{title}</span>
      </button>
      {actions && <div className="inspector-drill-header-actions">{actions}</div>}
    </div>
  );
}

export function DrillHeaderAction({
  kind,
  label,
  onClick,
  disabled = false,
  armed = false,
}: {
  kind: "duplicate" | "remove";
  label: string;
  onClick: () => void;
  disabled?: boolean;
  armed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`inspector-drill-header-action${kind === "remove" ? " danger" : ""}${armed ? " armed" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {kind === "duplicate" ? (
          <>
            <rect x="5" y="5" width="8" height="8" rx="1.5" />
            <path d="M3 10H2.5A1.5 1.5 0 0 1 1 8.5v-6A1.5 1.5 0 0 1 2.5 1h6A1.5 1.5 0 0 1 10 2.5V3" />
          </>
        ) : (
          <>
            <path d="M3 4h10M6 4V2.5h4V4M5 6.5v5M8 6.5v5M11 6.5v5" />
            <path d="M4 4l.6 9h6.8l.6-9" />
          </>
        )}
      </svg>
    </button>
  );
}
