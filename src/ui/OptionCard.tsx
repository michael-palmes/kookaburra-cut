import type { ReactNode } from "react";

/** One option-picker card: a still image, or a clip while hovered/selected; missing assets fall back to a text swatch. */
export function OptionCard({
  label,
  title,
  image,
  icon,
  clip,
  playing = false,
  size = "default",
  selected,
  onSelect,
  onHoverChange,
}: {
  label: string;
  /** Tooltip text; compact cards fall back to the label, which they ellipsise. */
  title?: string;
  /** `compact`: the dense look-browser tile (short thumb, one-line label). */
  size?: "default" | "compact";
  /** Poster/still URL (null = the text swatch placeholder). */
  image: string | null;
  /** A small inline glyph shown instead of a still (an explicit "none" state); takes priority over `image`. */
  icon?: ReactNode;
  /** Looping clip URL, rendered while `playing` (hover or selected). */
  clip?: string | null;
  playing?: boolean;
  selected: boolean;
  onSelect: () => void;
  onHoverChange?: (hovering: boolean) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a real <button> drops the img in WKWebView
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={title ?? (size === "compact" ? label : undefined)}
      className={`theme-card${size === "compact" ? " compact" : ""}${selected ? " selected" : ""}`}
      onClick={onSelect}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="theme-card-thumb">
        {clip && playing ? (
          <video src={clip} poster={image ?? undefined} autoPlay loop muted playsInline />
        ) : icon ? (
          <div className="option-card-icon">{icon}</div>
        ) : image ? (
          <img src={image} alt="" draggable={false} />
        ) : (
          <div className="option-card-swatch">{label}</div>
        )}
      </div>
      <div className="theme-card-meta">
        <span>{label}</span>
      </div>
    </div>
  );
}
