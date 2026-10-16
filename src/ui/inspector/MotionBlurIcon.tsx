/** A shutter disc open by `deg` (clockwise from the top), the angle the setting names. */
function shutterPaths(deg: number) {
  if (deg >= 360) {
    return (
      <>
        <circle cx="10" cy="10" r="6.5" />
        <circle cx="10" cy="10" r="4.6" fill="currentColor" stroke="none" />
      </>
    );
  }
  const rad = (Math.max(1, deg) * Math.PI) / 180;
  const x = 10 + 4.6 * Math.sin(rad);
  const y = 10 - 4.6 * Math.cos(rad);
  return (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path
        d={`M10 10V5.4A4.6 4.6 0 ${deg > 180 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}z`}
        fill="currentColor"
        stroke="none"
      />
    </>
  );
}

function dots(columns: number, rows: number) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      out.push(
        <circle
          key={`${r}-${c}`}
          cx={10 + (c - (columns - 1) / 2) * 4}
          cy={10 + (r - (rows - 1) / 2) * 4}
          r="1.1"
          fill="currentColor"
          stroke="none"
        />,
      );
    }
  }
  return out;
}

/** Motion blur glyphs in the SceneRowIcon treatment (20-unit viewBox, 1.5 strokes): `shutter-<deg>`, `streak`, `inherit`, `off`, `samples-<n>`, `camera`, `objects`, `playing`. */
export function MotionBlurIcon({ id, size = 17 }: { id: string; size?: number }) {
  const paths = (() => {
    if (id.startsWith("shutter-")) return shutterPaths(Number(id.slice(8)));
    switch (id) {
      case "streak":
        return (
          <>
            <circle cx="13" cy="10" r="3.5" />
            <path d="M2.5 7.5h5M2 10h6M2.5 12.5h5" />
          </>
        );
      case "inherit":
        return (
          <>
            <path d="M10 3.5v8M6.5 8l3.5 3.5L13.5 8" />
            <path d="M4.5 16h11" />
          </>
        );
      case "off":
        return (
          <>
            <circle cx="10" cy="10" r="6.5" />
            <path d="M5.4 14.6L14.6 5.4" />
          </>
        );
      case "samples-4":
        return dots(2, 2);
      case "samples-8":
        return dots(4, 2);
      case "samples-16":
        return dots(4, 4);
      case "camera":
        return (
          <>
            <path d="M3.5 7h3l1.2-1.8h4.6L13.5 7h3v8.5h-13z" />
            <circle cx="10" cy="11.1" r="2.6" />
          </>
        );
      case "objects":
        return (
          <>
            <path d="M10 3.5l5.5 3v7L10 16.5l-5.5-3v-7z" />
            <path d="M4.5 6.5L10 9.5l5.5-3M10 9.5v7" />
          </>
        );
      case "playing":
        return (
          <>
            <path d="M8.5 5.5v9l6.5-4.5z" />
            <path d="M2.5 8h3.5M2.5 12h3.5" />
          </>
        );
      default:
        return null;
    }
  })();
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
      {paths}
    </svg>
  );
}
