/** Drag-reorder maths for every catalogue that sorts on an `order` field (templates, presets, workspace themes). Pure, so the grids stay dumb: they hand over the ids in the order the user just dragged them into and write back what comes out. Renumbering in gaps leaves room for a later insert without rewriting the neighbours, and reordering is always scoped to ONE category, since `order` is a within-category sort key everywhere. */

/** The gap between neighbours after a renumber. */
export const CATALOGUE_ORDER_GAP = 10;

/** One item's new sort position, the shape the write commands take. */
export interface CatalogueOrderEntry {
  id: string;
  order: number;
}

/** Renumber a category's ids in gaps of 10, first item at 10. */
export function renumberOrders(ids: readonly string[]): CatalogueOrderEntry[] {
  return ids.map((id, index) => ({ id, order: (index + 1) * CATALOGUE_ORDER_GAP }));
}

/** Move one item within a list, drag semantics: `to` is the index the item ends up at once it has been lifted out. Out-of-range indices clamp; an unchanged move returns the same list. */
export function moveInList<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (next.length === 0) return next;
  const source = Math.min(next.length - 1, Math.max(0, Math.trunc(from)));
  const target = Math.min(next.length - 1, Math.max(0, Math.trunc(to)));
  if (source === target) return next;
  const [moved] = next.splice(source, 1);
  next.splice(target, 0, moved);
  return next;
}

/** One drag, end to end: the ids in their new order plus the renumbered orders to write. `changed` is false when the drag put everything back where it was, so the caller can skip the writes entirely. */
export function reorderCatalogue(
  ids: readonly string[],
  from: number,
  to: number,
): { ids: string[]; orders: CatalogueOrderEntry[]; changed: boolean } {
  const next = moveInList(ids, from, to);
  const changed = next.some((id, index) => id !== ids[index]);
  return { ids: next, orders: renumberOrders(next), changed };
}

/** The renumbered orders for a category whose current values have drifted (duplicates, gaps of 1, hand-edited files), keyed by the sort the catalogue already applies. Returns only the entries whose order actually moves, so a tidy category writes nothing. */
export function normaliseOrders(
  entries: readonly { id: string; order: number }[],
): CatalogueOrderEntry[] {
  const renumbered = renumberOrders(entries.map((entry) => entry.id));
  return renumbered.filter((entry, index) => entry.order !== entries[index].order);
}
