import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { reorderCatalogue } from "../engine/catalogueOrder";
import { devSetBuiltinThemeOrders, setWorkspaceThemeOrders } from "../engine/library";
import {
  bundledThemePreviews,
  cachedThemePreviews,
  THEME_PREVIEW_COUNT,
  themePreviewKey,
} from "../engine/themePreviews";
import {
  BUILTIN_THEME_CATALOGUE,
  filterThemeCatalogue,
  MY_THEMES_COLLECTION,
  parseThemeCatalogueMetadata,
  readCatalogueOrder,
  sortWorkspaceThemes,
  THEME_CATEGORIES,
  type ThemeCatalogueStage,
  type ThemeCategoryId,
} from "../theme/catalogue";
import { WORKSPACE_THEME_PREFIX } from "../theme/registry";
import { parseThemeDoc } from "../theme/schema";
import { canEditBundledThemes } from "./theme-editor/themeEditorIo";

export type ThemeChoiceSource = "bundled" | "workspace";

export interface ThemeChoice {
  id: string;
  name: string;
  source: ThemeChoiceSource;
  useLabel: string;
  tags: readonly string[];
  category?: ThemeCategoryId;
  stage?: ThemeCatalogueStage;
  fontTraits?: readonly string[];
  mode?: "light" | "dark";
  previews: string[] | null;
  background: string;
  accent: string;
  text: string;
  /** `catalogue.order`, when the document carries one; the sort key drag-reorder rewrites. */
  order?: number;
}

export type ThemeCollectionId = "all" | "recent" | ThemeCategoryId | "my-themes";

export const THEME_COLLECTIONS: readonly { id: ThemeCollectionId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "recent", label: "Recent" },
  ...THEME_CATEGORIES,
  MY_THEMES_COLLECTION,
];

export const RECENT_THEME_LIMIT = 8;
export const RECENT_THEMES_STORAGE_KEY = "kookaburra.recent-themes";
export const RECENT_THEMES_EVENT = "kookaburra:recent-themes";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

const CATEGORY_LABELS = new Map(THEME_CATEGORIES.map(({ id, label }) => [id, label]));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function normaliseSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-AU");
}

function browserStorage(): ThemeStorage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function fontTraits(headline: string, body: string): string[] {
  return [...new Set([headline, body])];
}

function inferredStage(theme: NonNullable<ReturnType<typeof parseThemeDoc>>): ThemeCatalogueStage {
  if (theme.backdrop && theme.backdrop.type !== "none") return "physical";
  return theme.lighting ? "lighting-only" : "none";
}

export function readRecentThemeIds(storage: ThemeStorage | undefined = browserStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(RECENT_THEMES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return [
      ...new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0)),
    ].slice(0, RECENT_THEME_LIMIT);
  } catch {
    return [];
  }
}

export function recordRecentThemeUse(
  id: string,
  storage: ThemeStorage | undefined = browserStorage(),
): string[] {
  const ids = [id, ...readRecentThemeIds(storage).filter((recentId) => recentId !== id)].slice(
    0,
    RECENT_THEME_LIMIT,
  );
  try {
    storage?.setItem(RECENT_THEMES_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    return ids;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<string[]>(RECENT_THEMES_EVENT, { detail: ids }));
  }
  return ids;
}

export async function recordSuccessfulThemeUse<T>(
  id: string,
  action: () => Promise<T>,
  storage: ThemeStorage | undefined = browserStorage(),
): Promise<T> {
  const result = await action();
  if (id) recordRecentThemeUse(id, storage);
  return result;
}

function choiceMatches(choice: ThemeChoice, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = normaliseSearch(
    [
      choice.id,
      choice.name,
      choice.useLabel,
      choice.source === "workspace" ? MY_THEMES_COLLECTION.label : "",
      choice.category ? CATEGORY_LABELS.get(choice.category) : "",
      choice.stage,
      ...choice.tags,
      ...(choice.fontTraits ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  );
  return terms.every((term) => haystack.includes(term));
}

export function filterThemeChoices(
  choices: readonly ThemeChoice[],
  collection: ThemeCollectionId = "all",
  query = "",
  recentIds: readonly string[] = [],
): ThemeChoice[] {
  const terms = normaliseSearch(query.trim()).split(/\s+/).filter(Boolean);
  if (terms.length > 0) return choices.filter((choice) => choiceMatches(choice, terms));
  if (collection === "all") return [...choices];
  if (collection === "my-themes") return choices.filter(({ source }) => source === "workspace");
  if (collection === "recent") {
    const byId = new Map(choices.map((choice) => [choice.id, choice]));
    return recentIds.flatMap((id) => {
      const choice = byId.get(id);
      return choice ? [choice] : [];
    });
  }
  return choices.filter(({ source, category }) => source === "bundled" && category === collection);
}

export function countThemeChoicesByCollection(
  choices: readonly ThemeChoice[],
  recentIds: readonly string[] = [],
): Record<ThemeCollectionId, number> {
  const counts = Object.fromEntries(THEME_COLLECTIONS.map(({ id }) => [id, 0])) as Record<
    ThemeCollectionId,
    number
  >;
  counts.all = choices.length;
  counts.recent = filterThemeChoices(choices, "recent", "", recentIds).length;
  counts[MY_THEMES_COLLECTION.id] = choices.filter(({ source }) => source === "workspace").length;
  for (const category of THEME_CATEGORIES) {
    counts[category.id] = choices.filter(
      ({ source, category: choiceCategory }) =>
        source === "bundled" && choiceCategory === category.id,
    ).length;
  }
  return counts;
}

export function builtinThemeChoices(): ThemeChoice[] {
  return filterThemeCatalogue(BUILTIN_THEME_CATALOGUE).map(({ theme, catalogue }) => ({
    id: theme.id,
    name: theme.name,
    source: "bundled",
    useLabel: catalogue.useLabel,
    tags: catalogue.tags,
    category: catalogue.category,
    stage: catalogue.stage,
    fontTraits: fontTraits(theme.typography.headline.family, theme.typography.body.family),
    mode: theme.mode,
    previews: bundledThemePreviews(theme.id),
    background: theme.colors.background,
    accent: theme.colors.accent,
    text: theme.colors.text,
  }));
}

export async function listThemeChoices(): Promise<ThemeChoice[]> {
  const choices = builtinThemeChoices();
  try {
    const listings = await invoke<{ slug: string; json: string }[]>("list_themes");
    const workspaceChoices = await Promise.all(
      listings.map(async ({ slug, json }): Promise<ThemeChoice | null> => {
        const id = `${WORKSPACE_THEME_PREFIX}${slug}`;
        try {
          const raw: unknown = JSON.parse(json);
          const theme = parseThemeDoc(raw, id);
          if (!theme) return null;
          const rawCatalogue = isRecord(raw) ? raw.catalogue : undefined;
          const metadata =
            rawCatalogue !== undefined ? parseThemeCatalogueMetadata(rawCatalogue, id) : undefined;
          // Read leniently: the reorder command writes `catalogue.order` alone, and a partial block the full parser rejects must still keep its sort key.
          const order = readCatalogueOrder(rawCatalogue);
          const previews = await themePreviewKey(json)
            .then((key) => cachedThemePreviews(key))
            .catch(() => null);
          return {
            id,
            name: theme.name,
            source: "workspace",
            useLabel: metadata?.useLabel ?? "Custom workspace theme",
            tags: metadata?.tags ?? [],
            category: metadata?.category,
            stage: metadata?.stage ?? inferredStage(theme),
            fontTraits: fontTraits(theme.typography.headline.family, theme.typography.body.family),
            mode: theme.mode,
            previews,
            background: theme.colors.background,
            accent: theme.colors.accent,
            text: theme.colors.text,
            ...(order === undefined ? {} : { order }),
          };
        } catch (error) {
          console.warn(`[theme] workspace theme "${id}" failed to list:`, error);
          return null;
        }
      }),
    );
    // My themes sort on `catalogue.order` when the documents carry one (drag-reorder writes it), alphabetically otherwise; the native listing's own order is only a tiebreak.
    choices.push(
      ...sortWorkspaceThemes(
        workspaceChoices.filter((choice): choice is ThemeChoice => choice !== null),
      ),
    );
  } catch (error) {
    console.warn("[theme] listing workspace themes failed:", error);
  }
  return choices;
}

function ThemeCard({
  choice,
  selected,
  tabIndex,
  cardRef,
  onFocus,
  onSelect,
  onNavigate,
  onContextMenu,
  drag,
  dragging = false,
  dropTarget = false,
}: {
  choice: ThemeChoice;
  selected: boolean;
  tabIndex: number;
  cardRef: (node: HTMLDivElement | null) => void;
  onFocus: () => void;
  onSelect: () => void;
  onNavigate: (event: React.KeyboardEvent) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Pointer-drag handlers, present only where the grid can reorder. */
  drag?: {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    /** True while a drag has passed the threshold; the card must swallow the click that follows. */
    swallowClick: () => boolean;
  };
  dragging?: boolean;
  dropTarget?: boolean;
}) {
  const [frame, setFrame] = useState(0);
  const [previewIntent, setPreviewIntent] = useState(false);
  const thumbRef = useRef<HTMLDivElement>(null);
  const previews = choice.previews;
  const src = previews ? previews[Math.min(frame, previews.length - 1)] : null;
  return (
    <div
      ref={cardRef}
      role="option"
      tabIndex={tabIndex}
      aria-selected={selected}
      aria-label={`${choice.name}, ${choice.useLabel}`}
      className={`theme-card${selected ? " selected" : ""}${dragging ? " dragging" : ""}${
        dropTarget ? " drop-target" : ""
      }`}
      onPointerEnter={() => setPreviewIntent(true)}
      onPointerDown={drag?.onPointerDown}
      onPointerMove={drag?.onPointerMove}
      onPointerUp={drag?.onPointerUp}
      onFocus={() => {
        setPreviewIntent(true);
        onFocus();
      }}
      onClick={() => {
        if (drag?.swallowClick()) return;
        onSelect();
      }}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
          return;
        }
        onNavigate(event);
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the parent option owns interaction */}
      <div
        ref={thumbRef}
        className="theme-card-thumb"
        onMouseMove={(event) => {
          if (!previews || !thumbRef.current) return;
          setPreviewIntent(true);
          const rect = thumbRef.current.getBoundingClientRect();
          const offset = (event.clientX - rect.left) / Math.max(1, rect.width);
          setFrame(
            Math.min(THEME_PREVIEW_COUNT - 1, Math.max(0, Math.floor(offset * previews.length))),
          );
        }}
        onMouseLeave={() => setFrame(0)}
      >
        {src ? (
          <img src={src} alt="" draggable={false} loading="lazy" decoding="async" />
        ) : (
          <div className="theme-card-swatch" style={{ background: choice.background }}>
            <span style={{ color: choice.text }}>Aa</span>
            <span className="theme-card-accent" style={{ background: choice.accent }} />
          </div>
        )}
        {previewIntent &&
          previews
            ?.slice(1)
            .map((preview) => (
              <img
                key={preview}
                className="theme-card-preload"
                src={preview}
                alt=""
                loading="eager"
                decoding="async"
                style={{ display: "none" }}
              />
            ))}
      </div>
      <div className="theme-card-meta">
        <span className="theme-card-name">{choice.name}</span>
        {choice.mode && <span className="theme-card-mode">{choice.mode}</span>}
        <span className="theme-card-use-label">{choice.useLabel}</span>
      </div>
    </div>
  );
}

export interface ThemeGridProps {
  choices: readonly ThemeChoice[];
  value: string;
  onChange: (id: string) => void;
  onCardContextMenu?: (choice: ThemeChoice, event: React.MouseEvent) => void;
  ariaLabel?: string;
  /** Present only where the listing has a writable order; a drag lands as one move (`from` lifted out, dropped at `to`). */
  onReorder?: (from: number, to: number) => void;
}

const PAGE_JUMP = 6;

/** How far a pointer travels before a press on a card becomes a drag instead of a click. */
const CARD_DRAG_THRESHOLD_PX = 6;

export function ThemeGrid({
  choices,
  value,
  onChange,
  onCardContextMenu,
  ariaLabel = "Themes",
  onReorder,
}: ThemeGridProps) {
  const initialFocus = choices.some(({ id }) => id === value) ? value : choices[0]?.id;
  const [focusId, setFocusId] = useState<string | undefined>(initialFocus);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  // Hand-rolled pointer drag (the scene manager's pattern), grid-aware: the drop index is whichever card the pointer is over, so it works across rows.
  const dragRef = useRef<{ index: number; startX: number; startY: number; moved: boolean } | null>(
    null,
  );
  const swallowClickRef = useRef(false);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  const cardIndexAt = (x: number, y: number): number | null => {
    let nearestIndex: number | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < choices.length; index++) {
      const node = refs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    return nearestIndex;
  };

  useEffect(() => {
    if (!choices.some(({ id }) => id === focusId)) {
      setFocusId(choices.some(({ id }) => id === value) ? value : choices[0]?.id);
    }
  }, [choices, focusId, value]);

  const moveFocus = (index: number) => {
    const choice = choices[index];
    if (!choice) return;
    setFocusId(choice.id);
    refs.current[index]?.focus();
  };

  const navigate = (event: React.KeyboardEvent, index: number) => {
    if (choices.length === 0) return;
    let next: number | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % choices.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + choices.length) % choices.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = choices.length - 1;
        break;
      case "PageUp":
        next = Math.max(0, index - PAGE_JUMP);
        break;
      case "PageDown":
        next = Math.min(choices.length - 1, index + PAGE_JUMP);
        break;
    }
    if (next === undefined) return;
    event.preventDefault();
    moveFocus(next);
  };

  const dragHandlers = (index: number) =>
    onReorder
      ? {
          onPointerDown: (event: React.PointerEvent) => {
            if (event.button !== 0) return;
            dragRef.current = {
              index,
              startX: event.clientX,
              startY: event.clientY,
              moved: false,
            };
          },
          onPointerMove: (event: React.PointerEvent) => {
            const current = dragRef.current;
            if (!current) return;
            if (
              !current.moved &&
              Math.hypot(event.clientX - current.startX, event.clientY - current.startY) <
                CARD_DRAG_THRESHOLD_PX
            ) {
              return;
            }
            if (!current.moved) {
              current.moved = true;
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            const over = cardIndexAt(event.clientX, event.clientY) ?? current.index;
            setDrag({ from: current.index, over });
          },
          onPointerUp: () => {
            const current = dragRef.current;
            const landing = drag;
            dragRef.current = null;
            setDrag(null);
            if (!current?.moved) return;
            // The click event still fires after the pointer sequence; the card asks before selecting.
            swallowClickRef.current = true;
            if (landing && landing.over !== current.index) onReorder(current.index, landing.over);
          },
          swallowClick: () => {
            const swallow = swallowClickRef.current;
            swallowClickRef.current = false;
            return swallow;
          },
        }
      : undefined;

  return (
    <div className="theme-grid" role="listbox" aria-label={ariaLabel}>
      {choices.map((choice, index) => (
        <ThemeCard
          key={choice.id}
          choice={choice}
          selected={value === choice.id}
          tabIndex={focusId === choice.id ? 0 : -1}
          drag={dragHandlers(index)}
          dragging={drag?.from === index}
          dropTarget={drag !== null && drag.over === index && drag.from !== index}
          cardRef={(node) => {
            refs.current[index] = node;
          }}
          onFocus={() => setFocusId(choice.id)}
          onSelect={() => onChange(choice.id)}
          onNavigate={(event) => navigate(event, index)}
          onContextMenu={
            onCardContextMenu ? (event) => onCardContextMenu(choice, event) : undefined
          }
        />
      ))}
    </div>
  );
}

export interface ThemeBrowserProps extends Omit<ThemeGridProps, "onReorder"> {
  layout?: "full" | "compact";
  initialCollection?: ThemeCollectionId;
  recentIds?: readonly string[];
  searchPlaceholder?: string;
  /** Called after a drag has rewritten the catalogue orders, so the host can re-list. */
  onReordered?: () => void;
}

/** Which listing a collection is showing, and so whether this build may rewrite its order: a use-case collection is bundled themes (checkout only, `catalogue.order` per JSON), My themes is the workspace. All/Recent mix both and search cuts across them, so neither reorders. */
export function reorderableScope(
  collection: ThemeCollectionId,
  searching: boolean,
): "bundled" | "workspace" | null {
  if (searching || collection === "all" || collection === "recent") return null;
  if (collection === MY_THEMES_COLLECTION.id) return "workspace";
  return canEditBundledThemes ? "bundled" : null;
}

/** Re-sorts one visible page by a drag's id order; ids the listing no longer has are ignored, and anything the drag never saw keeps its place at the end. */
export function applyDragOrder(
  choices: readonly ThemeChoice[],
  ids: readonly string[],
): ThemeChoice[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...choices].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function collectionAfterThemeSelection(
  activeCollection: ThemeCollectionId,
  query: string,
): ThemeCollectionId {
  return query.trim().length > 0 ? "all" : activeCollection;
}

function CollectionButton({
  collection,
  count,
  active,
  className,
  onSelect,
}: {
  collection: (typeof THEME_COLLECTIONS)[number];
  count: number;
  active: boolean;
  className: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`${className}${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span>{collection.label}</span>
      <span className="theme-browser-collection-count">{count}</span>
    </button>
  );
}

export function ThemeBrowser({
  choices,
  value,
  onChange,
  onCardContextMenu,
  ariaLabel = "Themes",
  layout = "full",
  initialCollection = "all",
  recentIds: suppliedRecentIds,
  searchPlaceholder = "Search themes",
  onReordered,
}: ThemeBrowserProps) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeCollection, setActiveCollection] = useState<ThemeCollectionId>(initialCollection);
  const previousValue = useRef(value);
  const [storedRecentIds, setStoredRecentIds] = useState(() => readRecentThemeIds());
  const recentIds = suppliedRecentIds ?? storedRecentIds;
  const searching = query.trim().length > 0;
  const effectiveCollection: ThemeCollectionId = searching ? "all" : activeCollection;
  // Ids in the order the last drag left them, pinned to the listing they were dragged in: the grid follows the drop immediately, and the override lapses on its own the moment the host re-lists.
  const [dragOrder, setDragOrder] = useState<{
    of: readonly ThemeChoice[];
    ids: string[];
  } | null>(null);
  const filtered = filterThemeChoices(choices, effectiveCollection, query, recentIds);
  const visibleChoices =
    dragOrder && dragOrder.of === choices ? applyDragOrder(filtered, dragOrder.ids) : filtered;
  const counts = countThemeChoicesByCollection(choices, recentIds);
  const scope = reorderableScope(effectiveCollection, searching);

  const reorder = (from: number, to: number) => {
    if (!scope) return;
    const ids = visibleChoices.map(({ id }) => id);
    const { ids: next, orders, changed } = reorderCatalogue(ids, from, to);
    if (!changed) return;
    setDragOrder({ of: choices, ids: next });
    const write =
      scope === "workspace"
        ? setWorkspaceThemeOrders(
            orders.map((entry) => ({
              ...entry,
              id: entry.id.slice(WORKSPACE_THEME_PREFIX.length),
            })),
          )
        : devSetBuiltinThemeOrders(orders);
    void write
      .then(() => onReordered?.())
      .catch((error) => console.warn("[theme] writing the new order failed:", error));
  };

  useEffect(() => {
    const changed = previousValue.current !== value;
    previousValue.current = value;
    if (changed && searching) setActiveCollection("all");
  }, [searching, value]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (suppliedRecentIds) return;
    const refreshRecents = (event: Event) => {
      const detail = (event as CustomEvent<string[]>).detail;
      setStoredRecentIds(Array.isArray(detail) ? detail : readRecentThemeIds());
    };
    window.addEventListener(RECENT_THEMES_EVENT, refreshRecents);
    return () => window.removeEventListener(RECENT_THEMES_EVENT, refreshRecents);
  }, [suppliedRecentIds]);

  const chooseCollection = (collection: ThemeCollectionId) => {
    setActiveCollection(collection);
    setQuery("");
  };

  const chooseTheme = (id: string) => {
    setActiveCollection(collectionAfterThemeSelection(activeCollection, query));
    onChange(id);
  };

  const collectionButtons = (className: string) =>
    THEME_COLLECTIONS.map((collection) => (
      <CollectionButton
        key={collection.id}
        collection={collection}
        count={counts[collection.id]}
        active={effectiveCollection === collection.id}
        className={className}
        onSelect={() => chooseCollection(collection.id)}
      />
    ));

  return (
    <section className={`theme-browser theme-browser-${layout}`}>
      <div className="theme-browser-search">
        <input
          ref={searchRef}
          type="search"
          className="modal-input theme-browser-search-input"
          value={query}
          placeholder={searchPlaceholder}
          aria-label="Search themes"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="theme-browser-result-count" aria-live="polite">
          {`${visibleChoices.length} ${visibleChoices.length === 1 ? "theme" : "themes"}`}
        </span>
      </div>
      {layout === "compact" && (
        <nav className="theme-browser-chips" aria-label="Theme collections">
          {collectionButtons("theme-browser-chip")}
        </nav>
      )}
      <div className="theme-browser-body">
        {layout === "full" && (
          <nav className="theme-browser-rail" aria-label="Theme collections">
            {collectionButtons("theme-browser-collection")}
          </nav>
        )}
        <div className="theme-browser-results">
          {visibleChoices.length > 0 ? (
            <>
              <ThemeGrid
                choices={visibleChoices}
                value={value}
                onChange={chooseTheme}
                onCardContextMenu={onCardContextMenu}
                ariaLabel={ariaLabel}
                onReorder={scope && visibleChoices.length > 1 ? reorder : undefined}
              />
              {scope && visibleChoices.length > 1 && (
                <p className="theme-browser-reorder-hint">
                  {scope === "workspace"
                    ? "Drag a card to reorder your library. The order saves into each theme.json."
                    : "Drag a card to reorder this collection. The order saves into each built-in theme JSON."}
                </p>
              )}
            </>
          ) : (
            <p className="theme-browser-empty" role="status">
              No themes found
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
