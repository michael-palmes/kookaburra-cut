/** Editor glyphs: hand-authored 13px stroke SVGs (the MediaBrowser icon precedent; no icon package). */

export type ToolIconId =
  | "split"
  | "freeze"
  | "tap"
  | "delete"
  | "mask"
  | "solid"
  | "blur"
  | "pixelate"
  | "addKey"
  | "deleteKey";

export function ToolIcon({ id }: { id: ToolIconId }) {
  const glyph = {
    split: (
      <>
        <path d="M8 1.5v13" strokeDasharray="2.2 1.8" />
        <rect x="1.5" y="4.5" width="4" height="7" rx="1" />
        <rect x="10.5" y="4.5" width="4" height="7" rx="1" />
      </>
    ),
    freeze: <path d="M8 2v12M2.8 5l10.4 6M13.2 5L2.8 11" />,
    tap: (
      <>
        <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="5.4" />
      </>
    ),
    delete: (
      <>
        <path d="M2.5 4.5h11" />
        <path d="M6 4.5V3h4v1.5" />
        <path d="M4 4.5l.8 9h6.4l.8-9" />
      </>
    ),
    mask: (
      <>
        <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
        <path d="M8 3.5h4.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8z" fill="currentColor" />
      </>
    ),
    solid: <rect x="2.5" y="4" width="11" height="8" rx="1.5" fill="currentColor" />,
    blur: (
      <>
        <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="5.6" strokeDasharray="1.6 1.7" />
      </>
    ),
    pixelate: (
      <>
        <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
        <rect x="2.5" y="2.5" width="5.5" height="5.5" fill="currentColor" stroke="none" />
        <rect x="8" y="8" width="5.5" height="5.5" fill="currentColor" stroke="none" />
      </>
    ),
    addKey: (
      <>
        <path d="M8 2.2L13.8 8 8 13.8 2.2 8z" />
        <path d="M8 5.6v4.8M5.6 8h4.8" />
      </>
    ),
    deleteKey: (
      <>
        <path d="M8 2.2L13.8 8 8 13.8 2.2 8z" />
        <path d="M5.6 8h4.8" />
      </>
    ),
  }[id];
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}
