import { formatPresetDuration, type PresetEntry } from "../engine/presets";
import { builtinThemes, defaultTheme } from "../theme/registry";
import { cardRoleProps, type LibraryCardInteraction, libraryCardClass } from "./TemplateCard";

/** The preset card: the template card's smaller sibling, one still instead of four (a preset is one scene, so there is nothing to cycle through). Same box, same fallback swatch, so both grids share a rhythm. */
export function PresetCard({
  entry,
  selected,
  tabStop,
  onSelect,
  interaction = {},
}: {
  entry: PresetEntry;
  selected: boolean;
  tabStop: boolean;
  onSelect: () => void;
  interaction?: LibraryCardInteraction;
}) {
  const theme = builtinThemes[entry.themeId] ?? defaultTheme;
  const select = interaction.mode !== "open";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the role rides in cardRoleProps: a real <button> drops the img in WKWebView
    <div
      {...cardRoleProps(select, selected)}
      data-preset-id={entry.id}
      tabIndex={tabStop ? 0 : -1}
      className={libraryCardClass("preset-card", selected, interaction)}
      onClick={select ? onSelect : undefined}
      onContextMenu={interaction.onContextMenu}
      onPointerDown={interaction.onPointerDown}
      onPointerMove={interaction.onPointerMove}
      onPointerUp={interaction.onPointerUp}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="template-card-thumb">
        {entry.previewUrl ? (
          <img src={entry.previewUrl} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <div className="template-card-swatch" style={{ background: theme.colors.background }}>
            <span style={{ color: theme.colors.text }}>Aa</span>
            <span className="template-card-accent" style={{ background: theme.colors.accent }} />
          </div>
        )}
      </div>
      <div className="template-card-body">
        <span className="template-card-name">{entry.name}</span>
        <p className="template-card-tagline">{entry.tagline}</p>
        <span className="template-card-meta">
          {`${formatPresetDuration(entry.durationMs)} · ${entry.primaryAspect}`}
        </span>
        <span className="template-card-chips">
          <span className="template-chip">{entry.categoryLabel ?? "Uncategorised"}</span>
          {entry.source === "user" && <span className="template-chip flag">My preset</span>}
          {entry.status === "beta" && <span className="template-chip flag">Beta</span>}
        </span>
      </div>
    </div>
  );
}
