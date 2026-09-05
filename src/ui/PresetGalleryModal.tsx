import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { insertPresetScene } from "../engine/presetInsert";
import {
  listAllPresets,
  PRESET_CATEGORIES,
  type PresetCategoryId,
  type PresetEntry,
  presetCategoryCounts,
  refreshUserPresets,
  searchPresets,
  subscribePresets,
} from "../engine/presets";
import { PRESET_CATEGORY_ICONS } from "./libraryIcons";
import { modalHost } from "./modalHost";
import { PresetCard } from "./PresetCard";
import { useEscapeClose } from "./useEscapeClose";

/** The From-preset gallery: every scene preset (bundled first, then the user's own) as a searchable card grid behind category chips, inserting the chosen one into the open project through the cross-project copy machinery (`engine/presetInsert`). It borrows the welcome library's card and category icons, so one preset looks the same wherever it is shown; filtering and counts are the registry's pure helpers, so the rules are unit-tested without rendering. Portals to the chrome root, since the inspector's drill pages animate with a transform, which would otherwise become the containing block for a fixed overlay. */

/** One heading's worth of cards. Categories keep their catalogue order and empty ones drop out; presets filing under none land in a trailing Uncategorised group. */
export interface PresetGroup {
  id: PresetCategoryId | "uncategorised";
  label: string;
  entries: PresetEntry[];
}

export function groupPresetsByCategory(entries: readonly PresetEntry[]): PresetGroup[] {
  const groups: PresetGroup[] = [];
  for (const category of PRESET_CATEGORIES) {
    const matched = entries.filter((entry) => entry.category === category.id);
    if (matched.length > 0) {
      groups.push({ id: category.id, label: category.label, entries: matched });
    }
  }
  const loose = entries.filter((entry) => entry.category === null);
  if (loose.length > 0) {
    groups.push({ id: "uncategorised", label: "Uncategorised", entries: loose });
  }
  return groups;
}

type ChipId = PresetCategoryId | "all";

/** Insert a scene from the preset library. The chosen preset's scene copies in at `position` (a fresh id minted natively, its assets copied along, the project's own theme applying by construction); `onDone` hands the host the new scene so it can reload and select it. */
export function PresetGalleryModal({
  slug,
  position,
  onDone,
  onCancel,
}: {
  /** Destination workspace project slug (no `ws:` prefix). */
  slug: string;
  /** Manifest index the new scene should land at (past the end appends). */
  position: number;
  onDone: (inserted: { file: string; index: number; name: string }) => void;
  onCancel: () => void;
}) {
  const entries = useSyncExternalStore(subscribePresets, listAllPresets, listAllPresets);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<ChipId>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useEscapeClose(onCancel, !busy);

  // The user's half hydrates behind the bundled one; the store subscription repaints when it lands.
  useEffect(() => {
    refreshUserPresets().catch((e) => setError(String(e)));
  }, []);

  const category = chip === "all" ? null : chip;
  const visible = useMemo(
    () => searchPresets(entries, { query, category }),
    [entries, query, category],
  );
  const counts = useMemo(() => presetCategoryCounts(entries, { query }), [entries, query]);
  const groups = useMemo(() => groupPresetsByCategory(visible), [visible]);
  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const active = flat.find((entry) => entry.id === selected) ?? flat[0] ?? null;

  const cards = () =>
    Array.from(gridRef.current?.querySelectorAll<HTMLElement>(".template-card") ?? []);
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
    const entry = flat[Math.min(flat.length - 1, Math.max(0, index))];
    if (!entry) return;
    setSelected(entry.id);
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-preset-id="${entry.id}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };

  const insert = async () => {
    if (!active || busy) return;
    if (active.sceneCount !== 1) {
      setError("This preset must contain exactly one scene before it can be inserted.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const inserted = await insertPresetScene({
        destSlug: slug,
        presetProjectId: active.projectId,
        position,
      });
      onDone({ file: inserted.file, index: inserted.index, name: active.name });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void insert();
      return;
    }
    const anchor = flat.findIndex((entry) => entry.id === active?.id);
    const columns = columnCount();
    const row = Math.floor(Math.max(0, anchor) / columns);
    if (e.key === "ArrowRight") moveTo(anchor + 1);
    else if (e.key === "ArrowLeft") moveTo(anchor - 1);
    else if (e.key === "ArrowDown") moveTo(anchor + columns);
    else if (e.key === "ArrowUp") moveTo(anchor - columns);
    else if (e.key === "Home") moveTo(e.metaKey ? 0 : row * columns);
    else if (e.key === "End") moveTo(e.metaKey ? flat.length - 1 : row * columns + columns - 1);
    else return;
    e.preventDefault();
  };

  const chips: { id: ChipId; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all },
    ...PRESET_CATEGORIES.map((c) => ({
      id: c.id as ChipId,
      label: c.label,
      count: counts.byCategory[c.id],
    })),
  ];

  return createPortal(
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Insert from preset">
      <div className="modal wizard-wide">
        <h2>Insert from preset</h2>
        <div className="template-gallery">
          <div className="template-gallery-bar">
            <input
              className="modal-input template-gallery-search"
              type="search"
              placeholder="Search presets…"
              aria-label="Search presets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="template-gallery-count" aria-live="polite">
              {`${visible.length} ${visible.length === 1 ? "preset" : "presets"}`}
            </span>
          </div>
          <fieldset className="wizard-presets" aria-label="Preset categories">
            {chips.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`chip${chip === row.id ? " selected" : ""}`}
                aria-pressed={chip === row.id}
                disabled={row.id !== "all" && row.count === 0}
                onClick={() => setChip(row.id)}
              >
                {PRESET_CATEGORY_ICONS[row.id]}
                {`${row.label} ${row.count}`}
              </button>
            ))}
          </fieldset>
          {flat.length === 0 ? (
            <div className="template-empty">
              <p>
                {entries.length === 0
                  ? "No scene presets yet. Right-click a scene and choose “Save as preset…” to start your library."
                  : query
                    ? `No presets match “${query}”.`
                    : "No presets match these filters."}
              </p>
              {entries.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setQuery("");
                    setChip("all");
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div
              ref={gridRef}
              className="template-gallery-results"
              role="radiogroup"
              aria-label="Scene presets"
              onKeyDown={onGridKeyDown}
            >
              {groups.map((group) => (
                <div key={group.id}>
                  <span className="modal-hint">{group.label}</span>
                  <div className="template-grid">
                    {group.entries.map((entry) => (
                      <PresetCard
                        key={entry.id}
                        entry={entry}
                        selected={active?.id === entry.id}
                        tabStop={active?.id === entry.id}
                        onSelect={() => setSelected(entry.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="modal-hint">
          The scene and its media copy in after the selected one, using this project's theme and
          styling while keeping scene overrides.
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !active}
            onClick={() => void insert()}
          >
            {busy ? "Inserting…" : "Insert scene"}
          </button>
        </div>
      </div>
    </div>,
    modalHost(),
  );
}
