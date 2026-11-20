import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/** One option-picker card: a still image, or a clip while hovered/selected; missing assets fall back to a text swatch. A selected clip plays once and holds its last frame (WCAG 2.2.2); hover or focus plays it again. */
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
  /** Clip URL, rendered while `playing` (hover or selected); it loops only while hovered or focused. */
  clip?: string | null;
  playing?: boolean;
  selected: boolean;
  onSelect: () => void;
  onHoverChange?: (hovering: boolean) => void;
}) {
  const [near, setNear] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const reduceMotion = usePrefersReducedMotion();
  // Under Reduce motion a clip plays only while the pointer or focus is on its card.
  const live = !!clip && (reduceMotion ? near : playing || near);
  useEffect(() => {
    if (near) videoRef.current?.play().catch(() => {});
  }, [near]);
  const hover = (on: boolean) => {
    setNear(on);
    onHoverChange?.(on);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a real <button> drops the img in WKWebView
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={title ?? (size === "compact" ? label : undefined)}
      className={`theme-card${size === "compact" ? " compact" : ""}${selected ? " selected" : ""}`}
      onClick={onSelect}
      onMouseEnter={() => hover(true)}
      onMouseLeave={() => hover(false)}
      onFocus={() => setNear(true)}
      onBlur={() => setNear(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="theme-card-thumb">
        {icon ? (
          <div className="option-card-icon">{icon}</div>
        ) : image ? (
          <img src={image} alt="" draggable={false} />
        ) : (
          <div className="option-card-swatch">{label}</div>
        )}
        {live && (
          // Layered over the still and shown from its first decoded frame, so hover never flashes an empty thumb.
          <video
            ref={videoRef}
            src={clip}
            autoPlay
            loop={near}
            muted
            playsInline
            onLoadedData={(e) => e.currentTarget.classList.add("ready")}
          />
        )}
      </div>
      <div className="theme-card-meta">
        <span>{label}</span>
      </div>
    </div>
  );
}
