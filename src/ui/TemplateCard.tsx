import { useRef, useState } from "react";
import {
  formatTemplateDuration,
  TEMPLATE_PREVIEW_COUNT,
  TEMPLATE_USE_LABELS,
  type TemplateEntry,
} from "../engine/templates";
import { builtinThemes, defaultTheme } from "../theme/registry";

/** The template card, shared by the new-project wizard (where it is one option in a radio grid) and the welcome screen's library (where it opens the item and drags to reorder). Mouse X across the poster cycles the committed stills; with none rendered yet the card falls back to the template theme's swatch at the same 16:9 box, so the grid never reflows when the art lands. A user template carries a single poster still, so its hover simply holds that frame. */

/** What a hosting grid wires into a card: the pointer plumbing for right-click menus and drag-reorder, plus the drop marker. */
export interface LibraryCardInteraction {
  /** `select` is the wizard's radio semantics; `open` is a plain activation. */
  mode?: "select" | "open";
  onContextMenu?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  /** This card is the one being dragged. */
  dragging?: boolean;
  /** The drop marker sits on this edge of the card. */
  drop?: "before" | "after" | null;
}

/** The card is a div, not a button: WKWebView will not reliably paint an `<img>` child inside a real button (the MediaBrowser lesson, same as ThemeCard). The wizard's grid is a radiogroup, the library's cards simply activate. */
export function cardRoleProps(select: boolean, selected: boolean) {
  return select ? { role: "radio", "aria-checked": selected } : { role: "button" };
}

/** The classes every library card shares, so a preset card lands in the same grid rhythm. */
export function libraryCardClass(
  extra: string,
  selected: boolean,
  interaction: LibraryCardInteraction,
): string {
  return [
    "template-card",
    extra,
    selected ? "selected" : "",
    interaction.dragging ? "dragging" : "",
    interaction.drop ? `drop-${interaction.drop}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The chips a card flags itself with, in reading order. */
export function templateCardFlags(entry: TemplateEntry): string[] {
  const flags: string[] = [];
  if (entry.source === "user") flags.push("My template");
  if (entry.status === "beta") flags.push("Beta");
  if (entry.level === "showcase") flags.push("Showcase");
  if (entry.storeLegal) flags.push("Store legal");
  return flags;
}

export function TemplateCard({
  entry,
  selected,
  tabStop,
  onSelect,
  interaction = {},
  previewFrame,
}: {
  entry: TemplateEntry;
  selected: boolean;
  /** The grid's single tab stop: the selection, or the first card when a filter hides it. */
  tabStop: boolean;
  onSelect: () => void;
  interaction?: LibraryCardInteraction;
  previewFrame?: number;
}) {
  // The card rests on the manifest's poster frame; hovering still sweeps all four stills.
  const poster = Math.min(TEMPLATE_PREVIEW_COUNT - 1, Math.max(0, entry.manifest.preview.poster));
  const [hoverFrame, setFrame] = useState<number | null>(null);
  const frame = previewFrame ?? hoverFrame ?? poster;
  const thumbRef = useRef<HTMLDivElement>(null);
  const previews = entry.previews;
  const src = previews ? previews[Math.min(frame, previews.length - 1)] : null;
  const theme = builtinThemes[entry.themeId] ?? defaultTheme;
  const flags = templateCardFlags(entry);
  const select = interaction.mode !== "open";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the role rides in cardRoleProps: a real <button> drops the img in WKWebView
    <div
      {...cardRoleProps(select, selected)}
      data-template-id={entry.id}
      tabIndex={tabStop ? 0 : -1}
      className={libraryCardClass("", selected, interaction)}
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only preview cycling, the parent card carries the interactive semantics */}
      <div
        ref={thumbRef}
        className="template-card-thumb"
        onMouseMove={(e) => {
          if (previewFrame !== undefined || !previews || !thumbRef.current) return;
          const rect = thumbRef.current.getBoundingClientRect();
          const t = (e.clientX - rect.left) / Math.max(1, rect.width);
          setFrame(
            Math.min(TEMPLATE_PREVIEW_COUNT - 1, Math.max(0, Math.floor(t * previews.length))),
          );
        }}
        onMouseLeave={() => setFrame(null)}
      >
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
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
          {`${entry.sceneCount} ${entry.sceneCount === 1 ? "scene" : "scenes"} · ${formatTemplateDuration(entry.durationMs)} · ${entry.primaryAspect}`}
        </span>
        {(entry.uses.length > 0 || flags.length > 0) && (
          <span className="template-card-chips">
            {entry.uses.slice(0, 2).map((use) => (
              <span key={use} className="template-chip">
                {TEMPLATE_USE_LABELS[use]}
              </span>
            ))}
            {flags.map((flag) => (
              <span key={flag} className="template-chip flag">
                {flag}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
