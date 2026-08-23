import { type ReactNode, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type CatalogueOrderEntry, renumberOrders } from "../engine/catalogueOrder";
import {
  deleteUserPreset,
  deleteUserTemplate,
  devDeleteBundledPreset,
  devDeleteBundledTemplate,
  devSetPresetOrders,
  devSetTemplateOrders,
  duplicatePresetToWorkspace,
  duplicateTemplateToWorkspace,
  setUserPresetOrders,
  setUserTemplateOrders,
} from "../engine/library";
import {
  listAllPresets,
  PRESET_CATEGORIES,
  type PresetEntry,
  refreshUserPresets,
  searchPresets,
  subscribePresets,
} from "../engine/presets";
import { isEditableProjectId } from "../engine/project";
import {
  listAllTemplates,
  refreshUserTemplates,
  searchTemplates,
  subscribeTemplates,
  TEMPLATE_CATEGORIES,
  type TemplateEntry,
} from "../engine/templates";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import type { ItemDetailsTarget, LibraryKind, LibrarySource } from "./libraryDetails";
import { PRESET_CATEGORY_ICONS, TEMPLATE_CATEGORY_ICONS } from "./libraryIcons";
import { libraryCardMenuItems } from "./libraryMenus";
import { dropTargetIndex, gridInsertionIndex } from "./libraryReorder";
import { PresetCard } from "./PresetCard";
import { TemplateCard } from "./TemplateCard";

/** One catalogue as a card grid, grouped by category and reorderable inside each group: the welcome screen's Templates, Presets, App templates and App presets. The four differ only in which list they read and which write commands a drag or a delete lands on, so they share this component; the bundled pair renders in a dev checkout only, which is also the only place its write commands exist. */

const CARD_DRAG_THRESHOLD_PX = 5;

type LibraryCard =
  | { kind: "template"; id: string; slug: string; entry: TemplateEntry }
  | { kind: "preset"; id: string; slug: string; entry: PresetEntry };

interface CategoryGroup {
  key: string;
  label: string;
  icon: ReactNode;
  cards: LibraryCard[];
}

interface DragState {
  index: number;
  startX: number;
  startY: number;
  /** Insertion point in the group's current order; null until the drag passes the threshold. */
  insertBefore: number | null;
}

function orderWriter(
  kind: LibraryKind,
  source: LibrarySource,
): (entries: CatalogueOrderEntry[]) => Promise<void> {
  if (kind === "template") return source === "user" ? setUserTemplateOrders : devSetTemplateOrders;
  return source === "user" ? setUserPresetOrders : devSetPresetOrders;
}

function groupByCategory(cards: LibraryCard[], kind: LibraryKind): CategoryGroup[] {
  const categories = kind === "template" ? TEMPLATE_CATEGORIES : PRESET_CATEGORIES;
  const icons = kind === "template" ? TEMPLATE_CATEGORY_ICONS : PRESET_CATEGORY_ICONS;
  const groups: CategoryGroup[] = categories.map((category) => ({
    key: category.id,
    label: category.label,
    icon: icons[category.id],
    cards: [],
  }));
  const uncategorised: CategoryGroup = {
    key: "uncategorised",
    label: "Uncategorised",
    icon: icons.uncategorised,
    cards: [],
  };
  for (const card of cards) {
    const category = card.entry.category;
    const group = category ? groups.find((g) => g.key === category) : undefined;
    (group ?? uncategorised).cards.push(card);
  }
  return [...groups, uncategorised].filter((group) => group.cards.length > 0);
}

/** The creation path, spelled out where the catalogue is still empty. */
function emptyMessage(kind: LibraryKind, source: LibrarySource): string {
  if (source === "bundled") {
    return kind === "template"
      ? "No templates ship in this checkout yet."
      : "No presets ship in this checkout yet.";
  }
  return kind === "template"
    ? "No templates yet. Right-click a project and choose Convert to template."
    : "No presets yet. Right-click a scene in a project and choose Save as preset.";
}

export function LibraryGrid({
  kind,
  source,
  query,
  onOpen,
  onNewProjectFrom,
  onEditDetails,
  onError,
  extra,
}: {
  kind: LibraryKind;
  source: LibrarySource;
  /** The welcome search, scoped to this section. */
  query: string;
  onOpen: (projectId: string) => void;
  /** Templates only: seed the new-project wizard with this template id. */
  onNewProjectFrom: (templateId: string) => void;
  onEditDetails: (target: ItemDetailsTarget) => void;
  onError: (message: string | null) => void;
  /** App templates hangs the remaining bundled projects here. */
  extra?: ReactNode;
}) {
  const templates = useSyncExternalStore(subscribeTemplates, listAllTemplates);
  const presets = useSyncExternalStore(subscribePresets, listAllPresets);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [override, setOverride] = useState<{ from: unknown; key: string; ids: string[] } | null>(
    null,
  );

  const entries = kind === "template" ? templates : presets;
  const cards = useMemo<LibraryCard[]>(() => {
    // A pack-sourced item is not the user's own, so it lists with the bundled half.
    const wanted = source === "user";
    if (kind === "template") {
      return searchTemplates(templates, { query })
        .filter((entry) => (entry.source === "user") === wanted)
        .map((entry) => ({ kind: "template", id: entry.id, slug: entry.slug, entry }));
    }
    return searchPresets(presets, { query })
      .filter((entry) => (entry.source === "user") === wanted)
      .map((entry) => ({ kind: "preset", id: entry.id, slug: entry.slug, entry }));
  }, [kind, source, query, templates, presets]);

  // A committed drag holds its own order until the catalogue it came from re-lists.
  const pending = override && override.from === entries ? override : null;
  const groups = useMemo(() => {
    const built = groupByCategory(cards, kind);
    if (!pending) return built;
    return built.map((group) => {
      if (group.key !== pending.key) return group;
      const byId = new Map(group.cards.map((card) => [card.id, card]));
      const ordered = pending.ids.flatMap((id) => {
        const card = byId.get(id);
        return card ? [card] : [];
      });
      const rest = group.cards.filter((card) => !pending.ids.includes(card.id));
      return { ...group, cards: [...ordered, ...rest] };
    });
  }, [cards, kind, pending]);

  const refresh = async (): Promise<void> => {
    if (kind === "template") await refreshUserTemplates();
    else await refreshUserPresets();
  };

  const run = (action: Promise<unknown>) => {
    onError(null);
    action.then(() => refresh()).catch((e) => onError(String(e)));
  };

  const duplicate = (card: LibraryCard) =>
    run(
      card.kind === "template"
        ? duplicateTemplateToWorkspace(card.id)
        : duplicatePresetToWorkspace(card.id),
    );

  const remove = (card: LibraryCard) => {
    if (source === "user") {
      run(card.kind === "template" ? deleteUserTemplate(card.slug) : deleteUserPreset(card.slug));
      return;
    }
    run(
      card.kind === "template"
        ? devDeleteBundledTemplate(card.slug)
        : devDeleteBundledPreset(card.slug),
    );
  };

  const openMenu = (card: LibraryCard, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      ariaLabel: `${card.entry.name} actions`,
      items: libraryCardMenuItems({
        kind,
        source,
        writable: isEditableProjectId(card.entry.projectId),
        onOpen: () => onOpen(card.entry.projectId),
        onNewProject: kind === "template" ? () => onNewProjectFrom(card.id) : undefined,
        onEditDetails: () =>
          onEditDetails({ kind, source, slug: card.slug, manifest: card.entry.manifest }),
        onDuplicate: () => duplicate(card),
        onDelete: () => remove(card),
      }),
    });
  };

  const commitOrder = (group: CategoryGroup, from: number, insertBefore: number) => {
    const ids = group.cards.map((card) => card.id);
    const to = dropTargetIndex(from, insertBefore);
    if (to === from) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const slugs = new Map(group.cards.map((card) => [card.id, card.slug]));
    setOverride({ from: entries, key: group.key, ids: next });
    onError(null);
    orderWriter(
      kind,
      source,
    )(renumberOrders(next.map((id) => slugs.get(id) ?? id)))
      .then(() => refresh())
      .catch((e) => {
        setOverride(null);
        onError(String(e));
      });
  };

  const total = cards.length;
  return (
    <div className="library-grid-wrap">
      {total === 0 && (
        <p className="welcome-no-matches">
          {query ? `Nothing matches “${query.trim()}”.` : emptyMessage(kind, source)}
        </p>
      )}
      {groups.map((group) => (
        <CategoryGrid
          key={group.key}
          group={group}
          onActivate={(card) => onOpen(card.entry.projectId)}
          onContextMenu={openMenu}
          onReorder={(from, insertBefore) => commitOrder(group, from, insertBefore)}
        />
      ))}
      {extra}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** One category's cards: a heading plus the grid the drag maths reads its boxes from. */
function CategoryGrid({
  group,
  onActivate,
  onContextMenu,
  onReorder,
}: {
  group: CategoryGroup;
  onActivate: (card: LibraryCard) => void;
  onContextMenu: (card: LibraryCard, e: React.MouseEvent) => void;
  /** `insertBefore` is an index in the group's current order. */
  onReorder: (from: number, insertBefore: number) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const cardBoxes = () =>
    Array.from(gridRef.current?.querySelectorAll<HTMLElement>(".template-card") ?? []).map((el) =>
      el.getBoundingClientRect(),
    );

  const onPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault(); // else the drag sweeps a text selection across the grid
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ index, startX: e.clientX, startY: e.clientY, insertBefore: null });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (drag.insertBefore === null && moved < CARD_DRAG_THRESHOLD_PX) return;
    setDrag({ ...drag, insertBefore: gridInsertionIndex(cardBoxes(), e.clientX, e.clientY) });
  };

  const onPointerUp = (index: number) => {
    if (!drag) return;
    const { insertBefore } = drag;
    setDrag(null);
    if (insertBefore === null) onActivate(group.cards[index]);
    else onReorder(index, insertBefore);
  };

  return (
    <section className="library-category">
      <h2 className="library-category-heading">
        {group.icon}
        <span>{group.label}</span>
        <span className="library-category-count">{group.cards.length}</span>
      </h2>
      <div ref={gridRef} className="library-grid">
        {group.cards.map((card, index) => {
          const interaction = {
            mode: "open" as const,
            dragging: drag?.index === index && drag.insertBefore !== null,
            drop:
              drag?.insertBefore === index
                ? ("before" as const)
                : drag?.insertBefore === index + 1 && index === group.cards.length - 1
                  ? ("after" as const)
                  : null,
            onContextMenu: (e: React.MouseEvent) => onContextMenu(card, e),
            onPointerDown: (e: React.PointerEvent) => onPointerDown(e, index),
            onPointerMove,
            onPointerUp: () => onPointerUp(index),
          };
          return card.kind === "template" ? (
            <TemplateCard
              key={card.id}
              entry={card.entry}
              selected={false}
              tabStop
              onSelect={() => onActivate(card)}
              interaction={interaction}
            />
          ) : (
            <PresetCard
              key={card.id}
              entry={card.entry}
              selected={false}
              tabStop
              onSelect={() => onActivate(card)}
              interaction={interaction}
            />
          );
        })}
      </div>
    </section>
  );
}
