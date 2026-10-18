/** Line icons for the authored beat grid's controls, shared by the Music drill and the beat lane menu. */
export type MusicGridIconType =
  | "grid"
  | "tempo"
  | "double"
  | "halve"
  | "meter"
  | "barone"
  | "downbeat"
  | "detect"
  | "clear";

export function MusicGridIcon({ type }: { type: MusicGridIconType }) {
  const glyph = {
    grid: <path d="M3 5h14M3 10h14M3 15h14M7 3.5v13M13 3.5v13" />,
    tempo: (
      <>
        <path d="M7.5 3.5h5l3 13h-11z" />
        <path d="M10 13l3-6" />
      </>
    ),
    double: (
      <>
        <path d="M4 15V5M8 15V5M12 15V5M16 15V5" />
        <path d="M2.5 10h1.5M8 10h4" />
      </>
    ),
    halve: (
      <>
        <path d="M4 15V5M16 15V5" />
        <path d="M7 10h6" />
      </>
    ),
    meter: (
      <>
        <path d="M4 15V5" strokeWidth="2" />
        <path d="M8 13V7M12 13V7M16 13V7" />
      </>
    ),
    barone: (
      <>
        <path d="M5 15V4.5" strokeWidth="2" />
        <path d="M9.5 7.5l2-1.5v8" />
        <path d="M9.5 14h4" />
      </>
    ),
    downbeat: (
      <>
        <path d="M10 3.5v9" />
        <path d="M6.5 9.5L10 13l3.5-3.5" />
        <path d="M4 16.5h12" />
      </>
    ),
    detect: (
      <>
        <path d="M3 10h2l1.5-4 3 8 2-6 1.5 2H17" />
      </>
    ),
    clear: (
      <>
        <path d="M4 5h12M8 5V3.5h4V5M6 5l.8 11h6.4L14 5" />
      </>
    ),
  }[type];
  return (
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
      {glyph}
    </svg>
  );
}
