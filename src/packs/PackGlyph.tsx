/** Restrained line-art hero for the packs window's one-message screens (no emoji, design.md §3.12), matching the
 * welcome screen's PlaceholderArt language: currentColor strokes, no fill, nothing decorative. */

type Variant = "import" | "done" | "empty";

export function PackGlyph({ variant }: { variant: Variant }) {
  return (
    <svg
      className="packs-glyph"
      width="72"
      height="72"
      viewBox="0 0 72 72"
      fill="none"
      aria-hidden="true"
    >
      {/* The pack itself: a lidded carton, the shape the whole window is about. */}
      <path
        d="M11 25.5 36 14l25 11.5v21L36 58 11 46.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M11 25.5 36 37l25-11.5M36 37v21"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {variant === "import" && (
        // Arriving: an arrow dropping into the open lid.
        <path
          d="M36 3v13m0 0 4.5-4.5M36 16l-4.5-4.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="packs-glyph-accent"
        />
      )}

      {variant === "done" && (
        <>
          <circle cx="57" cy="55" r="11" fill="var(--surface-window, #0d1016)" />
          <circle
            cx="57"
            cy="55"
            r="9.25"
            stroke="currentColor"
            strokeWidth="1.5"
            className="packs-glyph-accent"
          />
          <path
            d="m52.5 55 3 3 6-6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="packs-glyph-accent"
          />
        </>
      )}
    </svg>
  );
}
