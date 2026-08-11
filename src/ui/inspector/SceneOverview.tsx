import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";

export interface SceneOverviewContextRequest {
  x: number;
  y: number;
  returnFocus: HTMLButtonElement;
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

function ChevronIcon() {
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
      <path d="M8 5l5 5-5 5" />
    </svg>
  );
}

export function SceneOverviewSectionHeader({
  label,
  onAdd,
  addLabel,
  addDisabled = false,
  addTitle,
  expanded,
  controls,
  addButtonRef,
}: {
  label: string;
  onAdd?: () => void;
  addLabel?: string;
  addDisabled?: boolean;
  addTitle?: string;
  expanded?: boolean;
  controls?: string;
  addButtonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="inspector-scene-overview-section-header">
      <span className="inspector-scene-overview-section-label">{label}</span>
      {onAdd && addLabel && (
        <button
          ref={addButtonRef}
          type="button"
          className="inspector-scene-overview-add"
          aria-label={addLabel}
          aria-expanded={expanded}
          aria-controls={controls}
          aria-haspopup={controls ? "dialog" : undefined}
          title={addTitle ?? addLabel}
          disabled={addDisabled}
          onClick={onAdd}
        >
          <PlusIcon />
        </button>
      )}
    </div>
  );
}

export function SceneOverviewGroupHeader({
  label,
  icon,
  onOpen,
  openLabel,
  onAdd,
  addLabel,
  addDisabled = false,
  addTitle,
}: {
  label: string;
  icon: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
  onAdd: () => void;
  addLabel: string;
  addDisabled?: boolean;
  addTitle?: string;
}) {
  return (
    <div className="inspector-scene-overview-group-header">
      {onOpen ? (
        <button
          type="button"
          className="inspector-scene-overview-group-main"
          aria-label={openLabel ?? `Open ${label}`}
          onClick={onOpen}
        >
          <span className="inspector-scene-overview-group-icon">{icon}</span>
          <span className="inspector-scene-overview-group-label">{label}</span>
        </button>
      ) : (
        <div className="inspector-scene-overview-group-main">
          <span className="inspector-scene-overview-group-icon">{icon}</span>
          <span className="inspector-scene-overview-group-label">{label}</span>
        </div>
      )}
      <button
        type="button"
        className="inspector-scene-overview-group-add"
        aria-label={addLabel}
        title={addTitle ?? addLabel}
        disabled={addDisabled}
        onClick={onAdd}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

export function SceneOverviewEntityRow({
  rowId,
  domain,
  label,
  value,
  leading,
  selected,
  onOpen,
  onContextMenu,
}: {
  rowId: string;
  domain: string;
  label: string;
  value?: string;
  leading?: ReactNode;
  selected: boolean;
  onOpen: () => void;
  onContextMenu?: (request: SceneOverviewContextRequest) => void;
}) {
  const requestPointerMenu = (event: MouseEvent<HTMLButtonElement>) => {
    if (!onContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onContextMenu({
      x: event.clientX,
      y: event.clientY,
      returnFocus: event.currentTarget,
    });
  };
  const requestKeyboardMenu = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!onContextMenu) return;
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    onContextMenu({
      x: Math.min(rect.left + 24, rect.right),
      y: rect.bottom,
      returnFocus: event.currentTarget,
    });
  };
  return (
    <div
      className={`inspector-scene-overview-entity${selected ? " selected" : ""}`}
      data-overview-row-id={rowId}
      data-overview-domain={domain}
    >
      <button
        type="button"
        className="inspector-scene-overview-entity-body"
        aria-label={`Open ${label}`}
        aria-current={selected ? "true" : undefined}
        aria-keyshortcuts={onContextMenu ? "Shift+F10" : undefined}
        onClick={onOpen}
        onContextMenu={requestPointerMenu}
        onKeyDown={requestKeyboardMenu}
      >
        {leading && <span className="inspector-scene-overview-entity-leading">{leading}</span>}
        <span className="inspector-scene-overview-entity-label" title={label}>
          {label}
        </span>
        {value && <span className="inspector-scene-overview-entity-value">{value}</span>}
      </button>
      <button
        type="button"
        className="inspector-scene-overview-entity-open"
        aria-label={`Open ${label}`}
        aria-keyshortcuts={onContextMenu ? "Shift+F10" : undefined}
        title={`Open ${label}`}
        onClick={onOpen}
        onContextMenu={requestPointerMenu}
        onKeyDown={requestKeyboardMenu}
      >
        <ChevronIcon />
      </button>
    </div>
  );
}

export function SceneOverviewSettingRow({
  rowId,
  label,
  value,
  icon,
  disabled = false,
  disabledReason,
  onOpen,
}: {
  rowId: string;
  label: string;
  value?: string;
  icon: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="inspector-scene-overview-setting"
      data-overview-row-id={rowId}
      disabled={disabled}
      title={disabledReason}
      onClick={onOpen}
    >
      <span className="inspector-scene-overview-setting-icon">{icon}</span>
      <span className="inspector-scene-overview-setting-label">{label}</span>
      {value && <span className="inspector-scene-overview-setting-value">{value}</span>}
      {!disabled && (
        <span className="inspector-scene-overview-setting-chevron">
          <ChevronIcon />
        </span>
      )}
    </button>
  );
}

export interface SceneOverviewPickerItem {
  id: string;
  label: string;
  icon: ReactNode;
  disabledReason?: string;
  onPick: () => void;
}

export function SceneOverviewPicker({
  id,
  items,
}: {
  id?: string;
  items: SceneOverviewPickerItem[];
}) {
  return (
    <div id={id} className="inspector-scene-overview-picker" role="dialog" aria-label="Add content">
      <div className="inspector-scene-overview-picker-grid">
        {items.map((item) => {
          const statusId = item.disabledReason
            ? `${id ?? "content-picker"}-${item.id}-status`
            : undefined;
          return (
            <button
              type="button"
              key={item.id}
              className="inspector-scene-overview-picker-item"
              aria-disabled={item.disabledReason ? "true" : undefined}
              aria-describedby={statusId}
              title={item.disabledReason ?? `Add ${item.label.toLowerCase()}`}
              onClick={() => {
                if (!item.disabledReason) item.onPick();
              }}
            >
              <span className="inspector-scene-overview-picker-icon">{item.icon}</span>
              <span className="inspector-scene-overview-picker-copy">
                <span className="inspector-scene-overview-picker-label">{item.label}</span>
                {item.disabledReason && (
                  <span id={statusId} className="inspector-scene-overview-picker-status">
                    {item.disabledReason}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
