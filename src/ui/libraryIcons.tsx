import type { ReactElement, ReactNode } from "react";

/** Line glyphs for every library surface: the welcome rail, the category rows in the wizard and the library grids, the details modal's category chips and the card menus. Inline SVG (the exportIcons idiom, CSP allows no remote assets), one stroke weight, so an icon can sit in front of any option control without restyling it (design rule 10). */

/** A 24-viewBox rail/chip glyph. */
export function railIcon(children: ReactNode): ReactElement {
  return (
    <svg
      className="template-rail-icon"
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

const GRID_ICON = railIcon(
  <>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </>,
);

const UNCATEGORISED_ICON = railIcon(
  <>
    <rect x="4" y="5" width="16" height="14" rx="2" strokeDasharray="3 3" />
    <path d="M12 10v4" />
  </>,
);

/** The wizard rail, the library grid headings and the details modal all name a template category with the same glyph. */
export const TEMPLATE_CATEGORY_ICONS: Record<string, ReactElement> = {
  all: GRID_ICON,
  mine: railIcon(<path d="M7 4.5h10a1 1 0 011 1V20l-6-3.5L6 20V5.5a1 1 0 011-1z" />),
  uncategorised: UNCATEGORISED_ICON,
  "app-updates": railIcon(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 16V8m0 0l-3.5 3.5M12 8l3.5 3.5" />
    </>,
  ),
  "product-launch": railIcon(
    <>
      <path d="M12 3c3 2 4.2 6 3 9.5L12 15.5 9 12.5C7.8 9 9 5 12 3z" />
      <path d="M9.5 12.5l-3 2.5 1 2.5 3-1.2M14.5 12.5l3 2.5-1 2.5-3-1.2M12 16v4" />
      <circle cx="12" cy="8.4" r="1.2" />
    </>,
  ),
  "marketing-social": railIcon(
    <>
      <path d="M18 5v14l-8-3.2H6.5A2.5 2.5 0 0 1 4 13.3v-2.6a2.5 2.5 0 0 1 2.5-2.5H10L18 5z" />
      <path d="M8 16v3.5" />
    </>,
  ),
  presentations: railIcon(
    <>
      <rect x="4" y="4.5" width="16" height="10.5" rx="1.5" />
      <path d="M12 15v3m-3.5 2l3.5-2 3.5 2" />
    </>,
  ),
  "finance-crypto": railIcon(
    <>
      <path d="M4 17l5-5 3 3 8-8" />
      <path d="M16 7h4v4" />
    </>,
  ),
  "ai-developer": railIcon(
    <>
      <path d="M5 7l5 5-5 5" />
      <path d="M12 17h7" />
    </>,
  ),
};

export const PRESET_CATEGORY_ICONS: Record<string, ReactElement> = {
  all: GRID_ICON,
  starters: railIcon(
    <>
      <rect x="4" y="5.5" width="16" height="13" rx="1.5" />
      <path d="M4 10h16M9 5.5v4.5M15 5.5v4.5" />
    </>,
  ),
  uncategorised: UNCATEGORISED_ICON,
  openers: railIcon(
    <>
      <path d="M6 5v14" />
      <path d="M10 7.5v9l8-4.5z" />
    </>,
  ),
  features: railIcon(
    <>
      <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7L12 4z" />
      <path d="M17.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" />
    </>,
  ),
  "stats-charts": railIcon(
    <>
      <path d="M4.5 19.5h15" />
      <path d="M7.5 16V11m4.5 5V6m4.5 10v-7" />
    </>,
  ),
  devices: railIcon(
    <>
      <rect x="7.5" y="3.5" width="9" height="17" rx="2" />
      <path d="M10.5 6h3" />
    </>,
  ),
  closers: railIcon(
    <>
      <path d="M6 20V4.5" />
      <path d="M6 5h9l-1.6 3L15 11H6z" />
    </>,
  ),
};

/** Dev-only card badge: the item's card art is older than its authored JSON. */
export function LibraryStaleIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.3l2.8 1.7" />
    </svg>
  );
}

/** Welcome-rail rows: the project groups above, the library catalogues below. */
export type LibraryRailIconId =
  | "all"
  | "ungrouped"
  | "group"
  | "templates"
  | "presets"
  | "app-templates"
  | "app-presets";

const RAIL_ICONS: Record<LibraryRailIconId, ReactElement> = {
  all: GRID_ICON,
  ungrouped: railIcon(
    <>
      <path d="M3.5 7A1.5 1.5 0 015 5.5h4l2 2h8A1.5 1.5 0 0120.5 9v8A1.5 1.5 0 0119 18.5H5A1.5 1.5 0 013.5 17V7z" />
      <path d="M9 12.5h6" strokeDasharray="2 2.5" />
    </>,
  ),
  group: railIcon(
    <path d="M3.5 7A1.5 1.5 0 015 5.5h4l2 2h8A1.5 1.5 0 0120.5 9v8A1.5 1.5 0 0119 18.5H5A1.5 1.5 0 013.5 17V7z" />,
  ),
  templates: railIcon(
    <>
      <rect x="4" y="4.5" width="16" height="15" rx="2" />
      <path d="M4 9.5h16M9.5 9.5v10" />
    </>,
  ),
  presets: railIcon(
    <>
      <path d="M12 3.5l8 4.5-8 4.5-8-4.5 8-4.5z" />
      <path d="M4.5 12.5L12 16.7l7.5-4.2M4.5 16.5L12 20.7l7.5-4.2" />
    </>,
  ),
  "app-templates": railIcon(
    <>
      <rect x="4" y="4.5" width="16" height="15" rx="2" />
      <path d="M4 9.5h16M9.5 9.5v10" />
      <circle cx="17" cy="14.5" r="2.2" />
    </>,
  ),
  "app-presets": railIcon(
    <>
      <path d="M12 3.5l8 4.5-8 4.5-8-4.5 8-4.5z" />
      <path d="M4.5 13L12 17.2l7.5-4.2" />
      <circle cx="17" cy="19" r="2.2" />
    </>,
  ),
};

export function LibraryRailIcon({ id }: { id: LibraryRailIconId }) {
  return RAIL_ICONS[id];
}

/** Card-menu glyphs, at the scene menu's 20-viewBox weight so both menus read as one family. */
export type LibraryMenuIconId =
  | "open"
  | "new-project"
  | "convert"
  | "details"
  | "duplicate-to"
  | "group";

export function LibraryMenuIcon({ id }: { id: LibraryMenuIconId }) {
  const path = (children: ReactNode) => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
  switch (id) {
    case "open":
      return path(
        <>
          <path d="M11 3.5h5.5V9" />
          <path d="M16.5 3.5L9 11" />
          <path d="M15 12v3.5A1.5 1.5 0 0113.5 17h-9A1.5 1.5 0 013 15.5v-9A1.5 1.5 0 014.5 5H8" />
        </>,
      );
    case "new-project":
      return path(
        <>
          <rect x="3" y="3.5" width="14" height="13" rx="1.5" />
          <path d="M10 7.5v5M7.5 10h5" />
        </>,
      );
    case "convert":
      return path(
        <>
          <rect x="3" y="3.5" width="14" height="13" rx="1.5" />
          <path d="M3 8h14M7.5 8v8.5" />
          <path d="M11 12.5h4.5m-2-2l2 2-2 2" />
        </>,
      );
    case "details":
      return path(
        <>
          <path d="M4 6.5h12M4 10h12M4 13.5h7" />
          <circle cx="14.5" cy="13.5" r="2" />
        </>,
      );
    case "duplicate-to":
      return path(
        <>
          <rect x="3.5" y="3.5" width="8.5" height="8.5" rx="1.5" />
          <path d="M7.5 16.5h7a2 2 0 002-2v-7" />
          <path d="M14.5 5.5l2 2-2 2" />
        </>,
      );
    case "group":
      return path(
        <path d="M3 6a1.5 1.5 0 011.5-1.5h3l1.5 1.5h6.5A1.5 1.5 0 0117 7.5v6A1.5 1.5 0 0115.5 15h-11A1.5 1.5 0 013 13.5V6z" />,
      );
  }
}
