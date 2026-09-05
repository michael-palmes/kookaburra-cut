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
  type PresetEntry,
  presetCategoryCounts,
  refreshUserPresets,
  searchPresets,
  subscribePresets,
} from "../engine/presets";
import { type LoadedProject, sceneFileStem } from "../engine/project";
import { ensureSceneThumbs, listCachedSceneThumbs } from "../engine/sceneThumbs";
import { gapFromPlacement, placementFromGap } from "./insertMath";
import { LibraryRailIcon, PRESET_CATEGORY_ICONS, railIcon } from "./libraryIcons";
import { modalHost } from "./modalHost";
import { PresetCard } from "./PresetCard";
import { SceneInsertTimeline } from "./SceneInsertTimeline";
import type { WizardSceneInfo } from "./SceneWizards";
import { useEscapeClose } from "./useEscapeClose";

/** New scene and From preset share the library catalogue, cards and native insertion path. */

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
type PresetSourceTab = "app" | "mine";

export function presetsForSource(
  entries: readonly PresetEntry[],
  source: PresetSourceTab,
): PresetEntry[] {
  return entries.filter((entry) => (entry.source === "user") === (source === "mine"));
}

export function resolvePresetSelection(
  entries: readonly PresetEntry[],
  selectedId: string | null,
): PresetEntry | null {
  return selectedId === null
    ? (entries[0] ?? null)
    : (entries.find((entry) => entry.id === selectedId) ?? null);
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
  const panelId = useId();
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
  const [placement, setPlacement] = useState(() => placementFromGap(position, scenes.length));
  const [cachedThumbs, setCachedThumbs] = useState<Record<string, string>>({});
  const [source, setSource] = useState<PresetSourceTab>("app");
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<ChipId>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTicket = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  useEscapeClose(onCancel, !busy);

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

  const category = chip === "all" ? null : chip;
  const sourceEntries = useMemo(() => presetsForSource(entries, source), [entries, source]);
  const visible = useMemo(
    () => searchPresets(sourceEntries, { query, category }),
    [sourceEntries, query, category],
  );
  const counts = useMemo(
    () => presetCategoryCounts(sourceEntries, { query }),
    [sourceEntries, query],
  );
  const groups = useMemo(() => groupPresetsByCategory(visible), [visible]);
  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const active = resolvePresetSelection(flat, selected);

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
    if (e.key === "Enter") {
      e.preventDefault();
      const focusedId = (e.target as Element)
        .closest("[data-preset-id]")
        ?.getAttribute("data-preset-id");
      void insert(resolvePresetSelection(flat, focusedId ?? selected));
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
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal wizard-wide wizard-place-wide preset-gallery">
        <h2 id={titleId}>New scene</h2>
        <div className="template-gallery">
          <div className="wizard-presets" role="tablist" aria-label="Preset library">
            {(["app", "mine"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`${panelId}-${tab}`}
                aria-controls={panelId}
                aria-selected={source === tab}
                tabIndex={source === tab ? 0 : -1}
                className={`chip${source === tab ? " selected" : ""}`}
                disabled={busy}
                onClick={() => {
                  setSource(tab);
                  setChip("all");
                }}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "app"
                      : event.key === "End"
                        ? "mine"
                        : tab === "app"
                          ? "mine"
                          : "app";
                  setSource(next);
                  setChip("all");
                  document.getElementById(`${panelId}-${next}`)?.focus();
                }}
              >
                <LibraryRailIcon id={tab === "app" ? "app-presets" : "presets"} />
                {tab === "app" ? "App presets" : "My presets"}
              </button>
            ))}
          </div>
          <div className="template-gallery-bar">
            <input
              className="modal-input template-gallery-search"
              type="search"
              placeholder="Search presets…"
              aria-label="Search presets"
              value={query}
              disabled={busy}
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
                disabled={busy || (row.id !== "all" && row.count === 0)}
                onClick={() => setChip(row.id)}
              >
                {PRESET_CATEGORY_ICONS[row.id]}
                {`${row.label} ${row.count}`}
              </button>
            ))}
          </fieldset>
          <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${source}`} inert={busy}>
            {flat.length === 0 ? (
              <div className="template-empty">
                <p>
                  {sourceEntries.length === 0
                    ? source === "mine"
                      ? "No presets yet. Save a scene as a preset, or edit a copy from App presets in the library."
                      : "No app presets are available."
                    : query
                      ? `No presets match “${query}”.`
                      : "No presets match these filters."}
                </p>
                {sourceEntries.length > 0 && (
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
                          tabStop={(active?.id ?? flat[0]?.id) === entry.id}
                          onSelect={() => {
                            if (!busy) setSelected(entry.id);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {(project || suppliedScenes) && (
          <fieldset className="preset-gallery-placement" disabled={busy} inert={busy}>
            <legend className="wizard-label">Where?</legend>
            <SceneInsertTimeline
              scenes={scenes}
              thumbs={suppliedThumbs ?? cachedThumbs}
              value={placement}
              onChange={(value) => {
                if (!busy) setPlacement(value);
              }}
            />
          </fieldset>
        )}
        <p className="modal-hint">
          Insert a copy, then edit it in the scene inspector. The copy uses this project's theme and
          keeps the preset's scene overrides.
        </p>
        {selected !== null && !active && (
          <p className="modal-hint" role="status">
            The selected preset is no longer shown. Choose another preset or clear the filters.
          </p>
        )}
        {loadError && (
          <div>
            <p className="modal-error">{loadError}</p>
            <button
              type="button"
              className="btn"
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
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {railIcon(<path d="m6 6 12 12M18 6 6 18" />)}
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !active}
            onClick={() => void insert()}
          >
            {railIcon(<path d="M12 5v14M5 12h14" />)}
            {busy ? "Inserting…" : "Insert scene"}
          </button>
        </div>
      </div>
    </div>,
    modalHost(),
  );
}
