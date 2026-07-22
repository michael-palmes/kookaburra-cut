/** Preset icons for the export modal: inline SVGs only, since the CSP allows no remote assets and the modal is pure UI chrome (never in exported pixels). Brand glyphs carry their platform colours for glanceability; X and TikTok ride `currentColor` so they stay legible in both themes; Kookaburra Cut rows use the accent token via the `export-icon-accent` class. */

import type { ReactElement } from "react";

function brand(path: string, fill: string): ReactElement {
  return (
    <svg className="export-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} fill={fill} />
    </svg>
  );
}

function stroked(children: ReactElement, className = "export-icon"): ReactElement {
  return (
    <svg
      className={className}
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

const INSTAGRAM = (
  <svg className="export-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="5" stroke="#E4405F" strokeWidth="2" />
    <circle cx="12" cy="12" r="4.1" stroke="#E4405F" strokeWidth="2" />
    <circle cx="17.2" cy="6.8" r="1.35" fill="#E4405F" />
  </svg>
);

const FACEBOOK = brand(
  "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z",
  "#1877F2",
);

const TIKTOK = brand(
  "M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
  "currentColor",
);

const YOUTUBE = brand(
  "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  "#FF0000",
);

/** YouTube Shorts: the vertical rounded frame + play, reads distinctly beside the main YouTube tile at a glance. */
const SHORTS = (
  <svg className="export-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="6.5" y="2.5" width="11" height="19" rx="4.5" stroke="#FF0000" strokeWidth="2" />
    <path d="M10.5 9.2v5.6L15.2 12l-4.7-2.8z" fill="#FF0000" />
  </svg>
);

const LINKEDIN = brand(
  "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  "#0A66C2",
);

const X_LOGO = brand(
  "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  "currentColor",
);

const REDDIT = brand(
  "M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.91 2.961.91.477 0 2.105-.056 2.961-.91a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z",
  "#FF4500",
);

const TELEGRAM = brand(
  "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  "#26A5E4",
);

const TV = stroked(
  <>
    <rect x="2.5" y="4.5" width="19" height="13" rx="2" />
    <path d="M8.5 21h7" />
  </>,
);

const GLOBE = stroked(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a13.5 13.5 0 0 1 0 18M12 3a13.5 13.5 0 0 0 0 18" />
  </>,
);

/** Kookaburra Master: a filmstrip frame in the accent colour, the archive lane. */
const FILM = stroked(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
  </>,
  "export-icon export-icon-accent",
);

/** Kookaburra Standard: the check seal in the accent colour, the frozen, verified path. */
const SEAL = stroked(
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    <path d="M8.2 12.3l2.6 2.6 5-5.4" />
  </>,
  "export-icon export-icon-accent",
);

/** Custom: sliders. */
const SLIDERS = stroked(
  <>
    <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h13M21 17h-1" />
    <circle cx="15.5" cy="7" r="1.9" />
    <circle cx="9.5" cy="12" r="1.9" />
    <circle cx="18.5" cy="17" r="1.9" />
  </>,
);

/** User presets: a bookmark, "yours". */
const BOOKMARK = stroked(<path d="M7 3.5h10a1 1 0 0 1 1 1V20.5l-6-4-6 4V4.5a1 1 0 0 1 1-1z" />);

/** Sharing: an upload arrow out of a tray, the "send it to a chat" lane. */
const SHARE = stroked(
  <>
    <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
    <path d="M16 6l-4-4-4 4" />
    <path d="M12 2v13" />
  </>,
);

const BY_ID: Record<string, ReactElement> = {
  "kookaburra-standard": SEAL,
  "kookaburra-master": FILM,
  "share-h264": SHARE,
  "share-h265": SHARE,
  "meta-reels": INSTAGRAM,
  "meta-feed": FACEBOOK,
  tiktok: TIKTOK,
  youtube: YOUTUBE,
  "youtube-shorts": SHORTS,
  "linkedin-ads": LINKEDIN,
  "linkedin-organic": LINKEDIN,
  x: X_LOGO,
  reddit: REDDIT,
  telegram: TELEGRAM,
  ctv: TV,
  web: GLOBE,
  custom: SLIDERS,
};

/** The icon for a preset row: brand by id, bookmark for user (`ws:`) presets. */
export function presetIcon(id: string): ReactElement {
  return BY_ID[id] ?? (id.startsWith("ws:") ? BOOKMARK : GLOBE);
}

/** The footer Export button's glyph (arrow-up-from-tray), inherits the accent button's text colour. */
export const EXPORT_BUTTON_ICON = (
  <svg
    className="export-btn-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 15V4M8 7.5 12 3.5l4 4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </svg>
);
