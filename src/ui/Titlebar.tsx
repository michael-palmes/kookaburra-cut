import type { ReactNode } from "react";

/** Custom titlebar: 46px, draggable background, traffic lights inset into the left safe zone by the window config (`titleBarStyle: Overlay`); `data-tauri-drag-region` only starts a drag from elements that carry it, so interactive children need no explicit no-drag handling. The bar is a pure shell; App composes per-view content, and the old center actions now live in the command palette (ui/commandRegistry.ts). */
export function Titlebar({ children }: { children?: ReactNode }) {
  return (
    <header className="titlebar" data-tauri-drag-region>
      {children}
    </header>
  );
}

/** 30×30 icon-only projects button; the folder that leads back to the gallery. */
export function TitlebarProjects({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="titlebar-icon-btn"
      onClick={onClick}
      disabled={disabled}
      title="Back to your projects"
      aria-label="Back to your projects"
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2h6.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5z" />
      </svg>
    </button>
  );
}

/** Project identity: the name stacked over its display path, a static drag surface. `onCopyPath` turns the path into a button that copies the folder. */
export function TitlebarIdentity({
  name,
  path,
  onCopyPath,
}: {
  name: string;
  path?: string | null;
  onCopyPath?: () => void;
}) {
  return (
    <div className="titlebar-identity" data-tauri-drag-region>
      <span className="titlebar-name" title={name} data-tauri-drag-region>
        {name}
      </span>
      {path &&
        (onCopyPath ? (
          <button
            type="button"
            className="titlebar-path copyable"
            title={`${path}\nClick to copy the folder path`}
            aria-label={`${path}, copy folder path`}
            onClick={onCopyPath}
          >
            {path}
          </button>
        ) : (
          <span className="titlebar-path" title={path} data-tauri-drag-region>
            {path}
          </span>
        ))}
    </div>
  );
}

/** The ⌘K launcher: a recessed field-styled button with a trailing keycap; its label drops first in a tight titlebar. */
export function PaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="palette-trigger"
      onClick={onOpen}
      title="Find an action (⌘K)"
      aria-label="Find an action"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="9" cy="9" r="5.5" />
        <path d="M13.5 13.5L17 17" />
      </svg>
      <span className="titlebar-label">Find an action</span>
      <kbd className="palette-trigger-key">⌘K</kbd>
    </button>
  );
}

/** The Export CTA's upload glyph (the only accent-filled control in the chrome). */
export function ExportIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 3v9" />
      <path d="M6.5 6.5L10 3l3.5 3.5" />
      <path d="M4 12v3.2a1 1 0 001 1h10a1 1 0 001-1V12" />
    </svg>
  );
}

/** A rounded stop square, the Cancel control that takes Present's slot while an export runs. */
export function StopIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="10" height="10" rx="2" />
    </svg>
  );
}

/** A projection screen with a play mark, the Present CTA's glyph. */
export function PresentIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3h15" />
      <path d="M4 3v9.5a1 1 0 001 1h10a1 1 0 001-1V3" />
      <path d="M8.6 6.2v4.1l3.5-2.05-3.5-2.05z" />
      <path d="M10 13.5V17M7.5 17.5L10 17l2.5.5" />
    </svg>
  );
}
