import type { ReactElement } from "react";
import { LibraryRailIcon, railIcon } from "../ui/libraryIcons";
import type { ItemKind } from "./types";

/** The packs rail leads every tab with the kind's line glyph (design rule 10), in the library rail's weight. */
export const KIND_ICONS: Record<ItemKind, ReactElement> = {
  project: railIcon(
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M10.5 9.5v5l4-2.5-4-2.5z" />
    </>,
  ),
  template: <LibraryRailIcon id="templates" />,
  preset: <LibraryRailIcon id="presets" />,
  brand: railIcon(
    <>
      <path d="M3.5 11.4V5A1.5 1.5 0 015 3.5h6.4a1.5 1.5 0 011.06.44l7.6 7.6a1.5 1.5 0 010 2.12l-6.4 6.4a1.5 1.5 0 01-2.12 0l-7.6-7.6a1.5 1.5 0 01-.44-1.06z" />
      <circle cx="8.5" cy="8.5" r="1.5" />
    </>,
  ),
  theme: railIcon(
    <>
      <path d="M12 3.5a8.5 8.5 0 100 17c1.1 0 1.7-.8 1.7-1.6 0-1.2-.9-1.6-.9-2.6 0-.9.7-1.6 1.6-1.6h2.3a3.8 3.8 0 003.8-3.8c0-4.1-3.8-7.4-8.5-7.4z" />
      <circle cx="7.8" cy="11.5" r="1" />
      <circle cx="10.4" cy="7.6" r="1" />
      <circle cx="15" cy="8" r="1" />
    </>,
  ),
  font: railIcon(<path d="M5 19.5l6.2-15h1.6l6.2 15M7.4 13.8h9.2" />),
  object: railIcon(
    <>
      <path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5z" />
      <path d="M4.5 7.7L12 12l7.5-4.3M12 12v8.5" />
    </>,
  ),
  gradient: railIcon(
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4.5 15.5l11-11M9 19.5L19.5 9M14.5 19.5l5-5" />
    </>,
  ),
  exportPreset: railIcon(
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>,
  ),
  screenshot: railIcon(
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M20.5 15.5l-5-5-8.5 8.5" />
    </>,
  ),
};

export const DETAILS_ICON = railIcon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.2" />
  </>,
);
