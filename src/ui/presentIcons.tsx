/** Option icons for the Present modal: inline stroked SVGs riding currentColor (the exportIcons pattern), pure UI chrome. */

import type { ReactElement } from "react";

function stroked(children: ReactElement): ReactElement {
  return (
    <svg
      className="present-chip-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Stacked slides. */
export const SLIDESHOW_ICON = stroked(
  <>
    <rect x="3" y="6.5" width="15" height="11" rx="2" />
    <path d="M21 8.5v9a2 2 0 0 1-2 2H8" />
  </>,
);

/** Play triangle in a frame. */
export const VIDEO_ICON = stroked(
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M10.2 9v6l5-3-5-3z" />
  </>,
);

/** A floating window with its titlebar. */
export const WINDOW_ICON = stroked(
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M3.5 9h17" />
    <circle cx="6.6" cy="6.8" r="0.35" />
    <circle cx="9.1" cy="6.8" r="0.35" />
  </>,
);

/** Expand-to-corners. */
export const FULLSCREEN_ICON = stroked(
  <>
    <path d="M9 4H4v5" />
    <path d="M15 4h5v5" />
    <path d="M9 20H4v-5" />
    <path d="M15 20h5v-5" />
  </>,
);

/** A four-point sparkle for exact full frames. */
export const FULL_QUALITY_ICON = stroked(
  <>
    <path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2L12 3.5z" />
  </>,
);

/** Fast-forward chevrons for smooth playback. */
export const SMOOTH_ICON = stroked(
  <>
    <path d="M4.5 6.5v11l7-5.5-7-5.5z" />
    <path d="M12.5 6.5v11l7-5.5-7-5.5z" />
  </>,
);

/** A display on its stand, for the fullscreen display picker. */
export const DISPLAY_ICON = stroked(
  <>
    <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
    <path d="M9.5 20.5h5M12 17v3.5" />
  </>,
);
