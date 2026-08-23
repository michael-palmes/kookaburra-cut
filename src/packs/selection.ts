/** Export-picker selection maths, kept pure so the closure behaviour is testable without a window. */

import { EMPTY_SELECTION, type PackSelection, selectionKey } from "../engine/packs";
import type { ItemKind, SelectableItem } from "./types";

export interface SelectionState {
  /** What the user ticked directly. */
  chosen: Record<string, true>;
  /** Auto-included items the user then unticked, which is allowed and warned about. */
  excluded: Record<string, true>;
}

export const EMPTY_STATE: SelectionState = { chosen: {}, excluded: {} };

export function itemKey(kind: ItemKind, slug: string): string {
  return `${kind}:${slug}`;
}

export function isAuto(item: SelectableItem): boolean {
  return item.requiredBy.length > 0;
}

/** An item ships when it was ticked directly, or pulled in and not unticked. */
export function isIncluded(state: SelectionState, item: SelectableItem): boolean {
  const key = itemKey(item.kind, item.slug);
  if (state.excluded[key]) return false;
  if (state.chosen[key]) return true;
  return isAuto(item);
}

export function toggle(state: SelectionState, item: SelectableItem, next: boolean): SelectionState {
  const key = itemKey(item.kind, item.slug);
  const chosen = { ...state.chosen };
  const excluded = { ...state.excluded };
  if (next) {
    chosen[key] = true;
    delete excluded[key];
  } else {
    delete chosen[key];
    // Only auto-included items need an explicit exclusion; a direct untick is enough for the rest.
    if (isAuto(item)) excluded[key] = true;
  }
  return { chosen, excluded };
}

/** What `plan_pack` is asked to resolve: the user's direct ticks only. The closure is Rust's job. */
export function toPlanSelection(state: SelectionState): PackSelection {
  const selection: PackSelection = {
    ...EMPTY_SELECTION,
    projects: [],
    templates: [],
    presets: [],
    themes: [],
    fonts: [],
    objects: [],
    gradients: [],
    exportPresets: [],
    screenshots: [],
  };
  for (const key of Object.keys(state.chosen)) {
    const split = key.indexOf(":");
    const kind = key.slice(0, split) as ItemKind;
    const slug = key.slice(split + 1);
    const field = selectionKey(kind);
    (selection[field] as string[]).push(slug);
  }
  return selection;
}

/** What actually goes into the pack: everything included after exclusions. */
export function toBuildSelection(
  state: SelectionState,
  items: SelectableItem[],
  dropAssets?: Record<string, string[]>,
): PackSelection {
  const selection = toPlanSelection({ chosen: {}, excluded: {} });
  for (const item of items) {
    if (!isIncluded(state, item)) continue;
    (selection[selectionKey(item.kind)] as string[]).push(item.slug);
  }
  if (dropAssets && Object.keys(dropAssets).length > 0) selection.dropAssets = dropAssets;
  return selection;
}

export function includedItems(state: SelectionState, items: SelectableItem[]): SelectableItem[] {
  return items.filter((item) => isIncluded(state, item));
}

export function totalBytes(state: SelectionState, items: SelectableItem[]): number {
  return includedItems(state, items).reduce(
    // A reference-only font carries no bytes: the name travels, the file does not.
    (sum, item) => sum + (item.referenceOnly ? 0 : item.bytes),
    0,
  );
}

export function countByKind(
  state: SelectionState,
  items: SelectableItem[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of includedItems(state, items)) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  }
  return counts;
}

/** What breaks if this auto-included item is unticked, phrased for the inline warning. */
export function breakageWarning(item: SelectableItem): string | null {
  if (!isAuto(item)) return null;
  const who = item.requiredBy.join(", ");
  switch (item.kind) {
    case "theme":
      return `${who} will fall back to the default theme.`;
    case "font":
      return `Text in ${who} will render in a substitute face.`;
    case "object":
      return `${who} will be missing this 3D object.`;
    case "gradient":
      return `${who} will fall back to a flat colour.`;
    default:
      return `${who} needs this.`;
  }
}

/** A pack name that reads like a person made it: organisation, else publisher name, else a plain default. */
export function defaultPackName(organisation?: string, publisher?: string): string {
  const base = organisation?.trim() || publisher?.trim() || "Kookaburra Pack";
  return base;
}

export function slugifyFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "kookaburra-pack";
}
