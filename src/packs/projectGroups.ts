import type { SelectableItem } from "./types";

/** One block of the export picker's Projects list; `group` is null for the projects outside every group. */
export interface ProjectGroupSection {
  group: string | null;
  items: SelectableItem[];
}

/** Named groups A to Z, then the ungrouped projects, each keeping the catalogue's order. */
export function groupProjectItems(
  items: SelectableItem[],
  groups: ReadonlyMap<string, string>,
): ProjectGroupSection[] {
  const named = new Map<string, SelectableItem[]>();
  const ungrouped: SelectableItem[] = [];
  for (const item of items) {
    const group = groups.get(item.slug);
    if (!group) {
      ungrouped.push(item);
      continue;
    }
    const members = named.get(group);
    if (members) members.push(item);
    else named.set(group, [item]);
  }
  const sections: ProjectGroupSection[] = [...named]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, members]) => ({ group, items: members }));
  if (ungrouped.length > 0) sections.push({ group: null, items: ungrouped });
  return sections;
}

/** Matches the name, slug or group; an empty query keeps everything. */
export function matchesPackSearch(
  item: SelectableItem,
  query: string,
  group?: string | null,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [item.name, item.slug, group ?? ""].some((field) =>
    field.toLocaleLowerCase().includes(needle),
  );
}
