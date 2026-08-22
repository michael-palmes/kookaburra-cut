export function ComparisonSideIcon({
  side,
  size = 13,
}: {
  side: "before" | "after";
  size?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x={side === "before" ? 3.2 : 8}
        y="4.2"
        width="4.8"
        height="7.6"
        rx="1"
        fill="currentColor"
      />
    </svg>
  );
}
