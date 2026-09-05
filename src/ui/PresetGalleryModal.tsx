import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { insertPresetScene } from "../engine/presetInsert";
import {
  listAllPresets,
  PRESET_CATEGORIES,
  type PresetCategoryId,
  type PresetCounts,
  type PresetEntry,
  presetCategoryCounts,
  refreshUserPresets,
  searchPresets,
  subscribePresets,
} from "../engine/presets";
import { type LoadedProject, sceneFileStem } from "../engine/project";
import { ensureSceneThumbs, listCachedSceneThumbs } from "../engine/sceneThumbs";
import { builtinThemes, defaultTheme } from "../theme/registry";
import { gapFromPlacement, placementFromGap, placementText } from "./insertMath";
import { LibraryRailIcon, PRESET_CATEGORY_ICONS, railIcon } from "./libraryIcons";
import { modalHost } from "./modalHost";
import { SceneInsertTimeline } from "./SceneInsertTimeline";
import { sceneIndexAtPlayhead, type WizardSceneInfo } from "./SceneWizards";
import { cardRoleProps } from "./TemplateCard";
import { useEscapeClose } from "./useEscapeClose";

/** Add a scene: every entry point (playback bar, Claude rail, scene menus, the Scenes drill-in) raises this picker over the library catalogue and the native insertion path. One flat grid of app and user presets, a category rail that hides what the search empties, a My presets only switch, and the placement strip in the footer, where the primary action names the gap. */

export type ChipId = PresetCategoryId | "all";

/** The grid's pool: everything by default, the user's own presets when the switch is on. */
export function presetsForPool(entries: readonly PresetEntry[], mineOnly: boolean): PresetEntry[] {
  return entries.filter((entry) => !mineOnly || entry.source === "user");
}

/** Nothing is selected until a card is picked, and a pick that has left the visible set stays unresolved rather than substituting another preset. */
export function resolvePresetSelection(
  entries: readonly PresetEntry[],
  selectedId: string | null,
): PresetEntry | null {
  return selectedId === null ? null : (entries.find((entry) => entry.id === selectedId) ?? null);
}

export interface CategoryRow {
  id: ChipId;
  label: string;
  count: number;
}

/** The rail lists All, then only the categories the current search still fills. */
export function categoryRows(counts: PresetCounts): CategoryRow[] {
  return [
    { id: "all", label: "All", count: counts.all },
    ...PRESET_CATEGORIES.filter((c) => counts.byCategory[c.id] > 0).map((c) => ({
      id: c.id as ChipId,
      label: c.label,
      count: counts.byCategory[c.id],
    })),
  ];
}

/** A category the search has emptied falls back to All instead of filtering to nothing. */
export function effectiveChip(chip: ChipId, counts: PresetCounts): ChipId {
  return chip === "all" || counts.byCategory[chip] > 0 ? chip : "all";
}

/** The primary action names the placement once a preset is chosen. */
export function insertButtonLabel(
  hasSelection: boolean,
  gap: number,
  names: readonly string[],
): string {
  if (!hasSelection) return "Insert scene";
  const text = placementText(gap, names);
  return `Insert ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** The picker's card: the poster and the name, the tagline on hover. A user preset can share an app preset's name (Edit a copy), so it carries the library glyph. */
function AddSceneCard({
  entry,
  selected,
  tabStop,
  onSelect,
}: {
  entry: PresetEntry;
  selected: boolean;
  tabStop: boolean;
  onSelect: () => void;
}) {
  const theme = builtinThemes[entry.themeId] ?? defaultTheme;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the role rides in cardRoleProps: a real <button> drops the img in WKWebView
    <div
      {...cardRoleProps(true, selected)}
      data-preset-id={entry.id}
      tabIndex={tabStop ? 0 : -1}
      className={`add-scene-card${selected ? " selected" : ""}`}
      title={entry.tagline || undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="add-scene-card-thumb">
        {entry.previewUrl ? (
          <img src={entry.previewUrl} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <div className="template-card-swatch" style={{ background: theme.colors.background }}>
            <span style={{ color: theme.colors.text }}>Aa</span>
            <span className="template-card-accent" style={{ background: theme.colors.accent }} />
          </div>
        )}
        {selected && (
          <span className="add-scene-card-tick" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M1.5 5.5 4 8 8.5 2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
      </div>
      <div className="add-scene-card-body">
        <span className="add-scene-card-name">{entry.name}</span>
        {entry.source === "user" && (
          <span className="add-scene-card-mine" title="My preset">
            <LibraryRailIcon id="presets" />
          </span>
        )}
      </div>
    </div>
  );
}

/** The requested position seeds the placement strip; success returns the committed file for reload and selection. */
export function PresetGalleryModal({
  slug,
  position,
  project,
  scenes: suppliedScenes,
  thumbs: suppliedThumbs,
  onNeedThumbs,
  onDone,
  onCancel,
}: {
  /** Native destination slug or scoped template id. */
  slug: string;
  /** Manifest index the new scene should land at (past the end appends). */
  position: number;
  project?: LoadedProject;
  scenes?: WizardSceneInfo[];
  thumbs?: Record<string, string>;
  onNeedThumbs?: () => void;
  onDone: (inserted: { file: string; index: number; name: string }) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const entries = useSyncExternalStore(subscribePresets, listAllPresets, listAllPresets);
  const scenes = useMemo<WizardSceneInfo[]>(
    () =>
      suppliedScenes ??
      project?.slots.map((slot, index) => ({
        index,
        id: slot.id,
        file: project.sceneFiles[index],
        stem: sceneFileStem(project.sceneFiles[index]),
        name: project.sceneDocs[index]?.name ?? null,
        durationMs: slot.durationMs,
        startMs: slot.startMs,
        doc: project.sceneDocs[index],
      })) ??
      [],
    [suppliedScenes, project],
  );
  const names = useMemo(() => scenes.map((s) => s.name ?? s.id), [scenes]);
  // Read once on open: the strip badges the playhead scene whatever gap the caller seeded.
  const currentIndex = useMemo(
    () => (scenes.length > 0 ? sceneIndexAtPlayhead(scenes) : null),
    [scenes],
  );
  const [placement, setPlacement] = useState(() => placementFromGap(position, scenes.length));
  const [cachedThumbs, setCachedThumbs] = useState<Record<string, string>>({});
  const [mineOnly, setMineOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<ChipId>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTicket = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEscapeClose(onCancel, !busy);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!project) {
      onNeedThumbs?.();
      return;
    }
    const controller = new AbortController();
    const update = (thumbs: Record<string, string>) => {
      if (!controller.signal.aborted) setCachedThumbs(thumbs);
    };
    void listCachedSceneThumbs(project)
      .then(update)
      .catch(() => {});
    void ensureSceneThumbs(project, { signal: controller.signal })
      .then(update)
      .catch(() => {});
    const stop = listen("kookaburra://thumbs-updated", () => {
      void listCachedSceneThumbs(project)
        .then(update)
        .catch(() => {});
    });
    return () => {
      controller.abort();
      void stop.then((unlisten) => unlisten());
    };
  }, [project, onNeedThumbs]);

  const refresh = useCallback(async () => {
    const ticket = ++refreshTicket.current;
    setRefreshing(true);
    try {
      await refreshUserPresets();
      if (ticket === refreshTicket.current) setLoadError(null);
    } catch (e) {
      if (ticket === refreshTicket.current) setLoadError(String(e));
    } finally {
      if (ticket === refreshTicket.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      refreshTicket.current += 1;
    };
  }, [refresh]);

  const pool = useMemo(() => presetsForPool(entries, mineOnly), [entries, mineOnly]);
  const counts = useMemo(() => presetCategoryCounts(pool, { query }), [pool, query]);
  const rows = useMemo(() => categoryRows(counts), [counts]);
  const activeChip = effectiveChip(chip, counts);
  const visible = useMemo(
    () => searchPresets(pool, { query, category: activeChip === "all" ? null : activeChip }),
    [pool, query, activeChip],
  );
  const active = resolvePresetSelection(visible, selected);
  const gap = gapFromPlacement(placement, scenes.length);

  const cards = () =>
    Array.from(gridRef.current?.querySelectorAll<HTMLElement>(".add-scene-card") ?? []);
  const columnCount = () => {
    const all = cards();
    if (all.length === 0) return 1;
    const top = all[0].offsetTop;
    let columns = 0;
    for (const card of all) {
      if (card.offsetTop !== top) break;
      columns += 1;
    }
    return Math.max(1, columns);
  };
  const moveTo = (index: number) => {
    const entry = visible[Math.min(visible.length - 1, Math.max(0, index))];
    if (!entry) return;
    setSelected(entry.id);
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-preset-id="${entry.id}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };

  const insert = async (preset = active) => {
    if (!preset || busy) return;
    if (preset.sceneCount !== 1) {
      setError("This preset must contain exactly one scene before it can be inserted.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const inserted = await insertPresetScene({
        destSlug: slug,
        presetProjectId: preset.projectId,
        position: project || suppliedScenes ? gapFromPlacement(placement, scenes.length) : position,
      });
      onDone({ file: inserted.file, index: inserted.index, name: preset.name });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (busy) return;
    const focusedId =
      (e.target as Element).closest("[data-preset-id]")?.getAttribute("data-preset-id") ?? null;
    if (e.key === "Enter") {
      e.preventDefault();
      void insert(resolvePresetSelection(visible, focusedId ?? selected));
      return;
    }
    const anchor = visible.findIndex((entry) => entry.id === (focusedId ?? active?.id));
    const columns = columnCount();
    const row = Math.floor(Math.max(0, anchor) / columns);
    if (e.key === "ArrowRight") moveTo(anchor + 1);
    else if (e.key === "ArrowLeft") moveTo(anchor - 1);
    else if (e.key === "ArrowDown") moveTo(anchor + columns);
    else if (e.key === "ArrowUp") moveTo(anchor - columns);
    else if (e.key === "Home") moveTo(e.metaKey ? 0 : row * columns);
    else if (e.key === "End") moveTo(e.metaKey ? visible.length - 1 : row * columns + columns - 1);
    else return;
    e.preventDefault();
  };

  const clearFilters = () => {
    setQuery("");
    setChip("all");
  };

  const empty =
    pool.length === 0 ? (
      mineOnly ? (
        <div className="add-scene-empty">
          <span className="add-scene-empty-title">No presets of your own yet</span>
          <p>Save a scene as a preset, or edit a copy from App presets in the library.</p>
          <button type="button" className="btn btn-small" onClick={() => setMineOnly(false)}>
            <LibraryRailIcon id="app-presets" />
            Show app presets
          </button>
        </div>
      ) : (
        <div className="add-scene-empty">
          <span className="add-scene-empty-title">No app presets are available</span>
        </div>
      )
    ) : (
      <div className="add-scene-empty">
        <span className="add-scene-empty-title">
          {query ? `No presets match “${query}”` : "No presets match these filters"}
        </span>
        <p>Try a shorter word, or clear the category.</p>
        <button type="button" className="btn btn-small" onClick={clearFilters}>
          {railIcon(<path d="m6 6 12 12M18 6 6 18" />)}
          Clear search & filters
        </button>
      </div>
    );

  return createPortal(
    <div
      className="modal-overlay add-scene-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="modal add-scene-modal">
        <div className="add-scene-head">
          <h2 id={titleId}>Add a scene</h2>
          <div className="add-scene-search">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <path
                d="M10.5 10.5 14 14"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <input
              ref={searchRef}
              className="modal-input"
              type="search"
              placeholder="Search by name or purpose…"
              aria-label="Search presets"
              value={query}
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            disabled={busy}
            onClick={onCancel}
          />
        </div>
        <div className="add-scene-body" inert={busy}>
          <div className="add-scene-rail">
            <fieldset className="add-scene-rail-list" aria-label="Preset categories">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`add-scene-cat${activeChip === row.id ? " selected" : ""}`}
                  aria-pressed={activeChip === row.id}
                  onClick={() => setChip(row.id)}
                >
                  <span className="add-scene-cat-label">
                    {PRESET_CATEGORY_ICONS[row.id]}
                    <span>{row.label}</span>
                  </span>
                  <span className="add-scene-cat-count">{row.count}</span>
                </button>
              ))}
            </fieldset>
            <label className="add-scene-mine">
              <LibraryRailIcon id="presets" />
              <span className="add-scene-mine-label">My presets only</span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={mineOnly}
                  onChange={(e) => {
                    setMineOnly(e.target.checked);
                    setChip("all");
                  }}
                />
                <span className="toggle-switch-track" aria-hidden="true">
                  <span className="toggle-switch-thumb" />
                </span>
              </span>
            </label>
          </div>
          <div className="add-scene-results">
            {visible.length === 0 ? (
              empty
            ) : (
              <div
                ref={gridRef}
                className="add-scene-grid"
                role="radiogroup"
                aria-label="Scene presets"
                onKeyDown={onGridKeyDown}
              >
                {visible.map((entry) => (
                  <AddSceneCard
                    key={entry.id}
                    entry={entry}
                    selected={active?.id === entry.id}
                    tabStop={(active?.id ?? visible[0]?.id) === entry.id}
                    onSelect={() => setSelected(entry.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="add-scene-foot">
          <div inert={busy}>
            <SceneInsertTimeline
              scenes={scenes}
              thumbs={suppliedThumbs ?? cachedThumbs}
              value={placement}
              currentIndex={currentIndex}
              caption={false}
              onChange={(value) => {
                if (!busy) setPlacement(value);
              }}
            />
          </div>
          {selected !== null && !active && (
            <p className="modal-hint" role="status">
              The selected preset is no longer shown. Choose another preset or clear the filters.
            </p>
          )}
          {loadError && (
            <div className="add-scene-retry">
              <p className="modal-error">{loadError}</p>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || refreshing}
                onClick={() => void refresh()}
              >
                {railIcon(
                  <path d="M20 5v5h-5M4 19v-5h5M6 8a7 7 0 0 1 12-2l2 4M4 14l2 4a7 7 0 0 0 12-2" />,
                )}
                {refreshing ? "Refreshing…" : "Retry library refresh"}
              </button>
            </div>
          )}
          {error && <p className="modal-error">{error}</p>}
          <div className="add-scene-actions">
            <span className="add-scene-actions-title">Choose where it goes</span>
            <span className="add-scene-actions-hint">
              Drag the marker between scenes, or use ← →
            </span>
            <span className="add-scene-actions-spacer" />
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !active}
              onClick={() => void insert()}
            >
              {busy ? "Inserting…" : insertButtonLabel(active !== null, gap, names)}
            </button>
          </div>
        </div>
      </div>
    </div>,
    modalHost(),
  );
}
