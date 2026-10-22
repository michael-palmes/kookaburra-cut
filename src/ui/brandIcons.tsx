import type { ReactNode } from "react";

/** Line glyphs for the brand surfaces (the Brand drill, the Library's brand view and its category chips): 20-viewBox, 1.5 stroke, the RowIcon idiom. */

function glyph(children: ReactNode, size = 14): ReactNode {
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
      {children}
    </svg>
  );
}

/** A tag: the brand itself. */
export function BrandIcon({ size }: { size?: number }) {
  return glyph(
    <>
      <path d="M3.5 4.5a1 1 0 011-1h5.6l6.4 6.4-6.6 6.6-6.4-6.4z" />
      <circle cx="7.5" cy="7.5" r="1.2" />
    </>,
    size,
  );
}

/** A crossed circle: no brand. */
export function NoBrandIcon({ size }: { size?: number }) {
  return glyph(
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M5.4 14.6l9.2-9.2" />
    </>,
    size,
  );
}

const ALL_ICON = (
  <>
    <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.2" />
    <rect x="11" y="3.5" width="5.5" height="5.5" rx="1.2" />
    <rect x="3.5" y="11" width="5.5" height="5.5" rx="1.2" />
    <rect x="11" y="11" width="5.5" height="5.5" rx="1.2" />
  </>
);

const CATEGORY_ICONS: Record<string, ReactNode> = {
  logos: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M7 12.5l3-6 3 6M8 10.8h4" />
    </>
  ),
  backgrounds: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3.5 13.5l4-4 3 3 2-2 4 3.5" />
    </>
  ),
  icons: (
    <>
      <path d="M10 3.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L10 13.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
    </>
  ),
  illustrations: (
    <>
      <path d="M13.5 3.5l3 3-8.5 8.5H5v-3z" />
      <path d="M11.5 5.5l3 3" />
    </>
  ),
  product: (
    <>
      <rect x="6" y="2.5" width="8" height="15" rx="2" />
      <path d="M9 15h2" />
    </>
  ),
  photography: (
    <>
      <path d="M3 7a1.5 1.5 0 011.5-1.5h2l1.2-2h4.6l1.2 2h2A1.5 1.5 0 0117 7v7.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 14.5z" />
      <circle cx="10" cy="10.5" r="2.8" />
    </>
  ),
};

const FOLDER_ICON = (
  <path d="M3 5.5a1 1 0 011-1h3.5l1.5 1.5h7a1 1 0 011 1v8a1 1 0 01-1 1H4a1 1 0 01-1-1z" />
);

/** A category chip's glyph: the known brand folders get their own, anything else a folder; `null` is the All chip. */
export function BrandCategoryIcon({ category }: { category: string | null }) {
  if (category === null) return glyph(ALL_ICON, 13);
  return glyph(CATEGORY_ICONS[category.toLowerCase()] ?? FOLDER_ICON, 13);
}
