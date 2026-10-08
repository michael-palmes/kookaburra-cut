import type { ReactNode } from "react";

/** Stills glyphs at the scene-menu geometry (17px, 20 viewBox, 1.5 stroke), shared by the scene menu, the key menu and the Stills drill. */

export type StillsIconId =
  | "stills"
  | "stills-off"
  | "still-auto"
  | "still-key"
  | "still-time"
  | "still-add"
  | "still-remove"
  | "jump";

export const STILLS_ICON_IDS: readonly StillsIconId[] = [
  "stills",
  "stills-off",
  "still-auto",
  "still-key",
  "still-time",
  "still-add",
  "still-remove",
  "jump",
];

const FRAME = <rect x="3" y="6" width="11.5" height="9.5" rx="1.5" />;

const GLYPHS: Record<StillsIconId, ReactNode> = {
  stills: (
    <>
      {FRAME}
      <path d="M6 3.5h9.5A1.5 1.5 0 0117 5v8" />
    </>
  ),
  "stills-off": (
    <>
      {FRAME}
      <path d="M6 3.5h9.5A1.5 1.5 0 0117 5v8" />
      <path d="M3 3l14 14" />
    </>
  ),
  "still-auto": (
    <>
      <rect x="3" y="4.5" width="14" height="11" rx="1.5" />
      <path d="M10 7l.9 2.1L13 10l-2.1.9L10 13l-.9-2.1L7 10l2.1-.9z" />
    </>
  ),
  "still-key": <path d="M10 4l6 6-6 6-6-6z" />,
  "still-time": (
    <>
      <path d="M10 6.5V17" />
      <path d="M7 3h6l-3 3.5z" />
    </>
  ),
  "still-add": (
    <>
      <rect x="2.5" y="4" width="11.5" height="9.5" rx="1.5" />
      <path d="M15.5 11.5v6M12.5 14.5h6" />
    </>
  ),
  "still-remove": (
    <>
      <rect x="2.5" y="4" width="11.5" height="9.5" rx="1.5" />
      <path d="M12.5 15.5h6" />
    </>
  ),
  jump: (
    <>
      <path d="M3.5 10h9M9.5 6.5l3.5 3.5-3.5 3.5" />
      <path d="M16.5 4v12" />
    </>
  ),
};

export function StillsIcon({ id, size = 17 }: { id: StillsIconId; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[id]}
    </svg>
  );
}
