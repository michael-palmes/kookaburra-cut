import { type ReactNode, useEffect, useState } from "react";

/** Inspector building blocks: the action row (17px icon · 13px label · right value · ›; selected = accent-subtle wash + a 2px inset accent edge, never a full accent fill) and the collapsible section header (chevron rotates −90° when collapsed); rendered from the pure models in ui/inspectorOptions.ts. */

/** One numeric field for pose-style grids: seeds from the value, commits on blur/Enter (shared by the Camera section and the device Rotation drill-in). */
export function NumericField({
  label,
  value,
  decimals,
  onCommit,
}: {
  label: string;
  value: number;
  decimals: number;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(value.toFixed(decimals));
  useEffect(() => setText(value.toFixed(decimals)), [value, decimals]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(value.toFixed(decimals));
      return;
    }
    if (Math.abs(n - value) > 10 ** -decimals / 2) onCommit(n);
  };
  return (
    <label className="inspector-pose-field">
      <input
        className="modal-input inspector-num"
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(value.toFixed(decimals));
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
    theme: <path d="M10 3s5 5.5 5 8.5a5 5 0 01-10 0C5 8.5 10 3 10 3z" />,
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
      {value && <span className="action-row-value">{value}</span>}
      {chevron && <Chevron />}
    </button>
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

/** Collapsible section header; the body is the caller's affair. The toggle is an inner button so a `trailing` control (e.g. the Camera section's Reset) never nests interactive elements. */
export function SectionHeader({
  label,
  collapsed,
  onToggle,
  trailing,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="inspector-section-head">
      <button
        type="button"
        className="inspector-section-toggle"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span className={`inspector-section-chev${collapsed ? " collapsed" : ""}`}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M6 8l4 4 4-4" />
          </svg>
        </span>
        <span className="inspector-section-label">{label}</span>
      </button>
      {trailing && <span className="inspector-section-trailing">{trailing}</span>}
    </div>
  );
}
