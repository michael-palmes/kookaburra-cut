/** One option-picker card: a still image, or a clip while hovered/selected; missing assets fall back to a text swatch. */
export function OptionCard({
  label,
  title,
  image,
  clip,
  playing = false,
  selected,
  onSelect,
  onHoverChange,
}: {
  label: string;
  /** Tooltip text. */
  title?: string;
  /** Poster/still URL (null = the text swatch placeholder). */
  image: string | null;
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
      title={title}
      className={`theme-card${selected ? " selected" : ""}`}
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
