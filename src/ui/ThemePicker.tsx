import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import {
  bundledThemePreviews,
  cachedThemePreviews,
  THEME_PREVIEW_COUNT,
  themePreviewKey,
} from "../engine/themePreviews";
import { lineupThemes, WORKSPACE_THEME_PREFIX } from "../theme/registry";
import { parseThemeDoc } from "../theme/schema";

/** Theme picking: the grid of hover-cycled preview cards shared by the New-project theme step and the main-window theme mode; bundled themes show their committed previews (`src/assets/theme-previews/`), workspace themes show their content-hash-cached set when one exists, else a colour-swatch placeholder (previews regenerate when the wizard saves the theme); hovering cycles the 4 standard scenes by horizontal position, the MediaBrowser hover-scrub pattern. */

export interface ThemeChoice {
  id: string;
  name: string;
  mode?: "light" | "dark";
  /** All 4 preview URLs in scene order, or null → the swatch placeholder. */
  previews: string[] | null;
  /** Placeholder swatch colours (the theme's own tokens). */
  background: string;
  accent: string;
  text: string;
}

/** The bundled lineup + workspace themes, with whatever previews exist right now. */
export async function listThemeChoices(): Promise<ThemeChoice[]> {
  const choices: ThemeChoice[] = lineupThemes().map((t) => ({
    id: t.id,
    name: t.name,
    mode: t.mode,
    previews: bundledThemePreviews(t.id),
    background: t.colors.background,
    accent: t.colors.accent,
    text: t.colors.text,
  }));
  try {
    const listings = await invoke<{ slug: string; json: string }[]>("list_themes");
    for (const { slug, json } of listings) {
      const id = `${WORKSPACE_THEME_PREFIX}${slug}`;
      const theme = parseThemeDoc(JSON.parse(json), id);
      if (!theme) continue;
      const previews = await cachedThemePreviews(await themePreviewKey(json)).catch(() => null);
      choices.push({
        id,
        name: theme.name,
        mode: theme.mode,
        previews,
        background: theme.colors.background,
        accent: theme.colors.accent,
        text: theme.colors.text,
      });
    }
  } catch (e) {
    console.warn("[theme] listing workspace themes failed:", e);
  }
  return choices;
}

/** One hover-cycled preview card: a `div role="button"`, not a `<button>`, since WKWebView won't reliably paint an `<img>` child inside a real button (the MediaBrowser lesson). */
function ThemeCard({
  choice,
  selected,
  onSelect,
  onContextMenu,
}: {
  choice: ThemeChoice;
  selected: boolean;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [frame, setFrame] = useState(0);
  const thumbRef = useRef<HTMLDivElement>(null);
  const previews = choice.previews;
  const src = previews ? previews[Math.min(frame, previews.length - 1)] : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a real <button> drops the img in WKWebView
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={`theme-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only preview cycling — the parent card carries the interactive semantics */}
      <div
        ref={thumbRef}
        className="theme-card-thumb"
        onMouseMove={(e) => {
          if (!previews || !thumbRef.current) return;
          const rect = thumbRef.current.getBoundingClientRect();
          const t = (e.clientX - rect.left) / Math.max(1, rect.width);
          setFrame(Math.min(THEME_PREVIEW_COUNT - 1, Math.max(0, Math.floor(t * previews.length))));
        }}
        onMouseLeave={() => setFrame(0)}
      >
        {src ? (
          <img src={src} alt="" draggable={false} />
        ) : (
          <div className="theme-card-swatch" style={{ background: choice.background }}>
            <span style={{ color: choice.text }}>Aa</span>
            <span className="theme-card-accent" style={{ background: choice.accent }} />
          </div>
        )}
      </div>
      <div className="theme-card-meta">
        <span>{choice.name}</span>
        {choice.mode && <span className="theme-card-mode">{choice.mode}</span>}
      </div>
    </div>
  );
}

/** The picker grid. `value` is a themeId (`kookaburra-*` or `ws:<slug>`). */
export function ThemeGrid({
  choices,
  value,
  onChange,
  onCardContextMenu,
}: {
  choices: ThemeChoice[];
  value: string;
  onChange: (id: string) => void;
  /** Right-click on a card (the theme context menu). */
  onCardContextMenu?: (choice: ThemeChoice, e: React.MouseEvent) => void;
}) {
  return (
    <div className="theme-grid">
      {choices.map((choice) => (
        <ThemeCard
          key={choice.id}
          choice={choice}
          selected={value === choice.id}
          onSelect={() => onChange(choice.id)}
          onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(choice, e) : undefined}
        />
      ))}
    </div>
  );
}
