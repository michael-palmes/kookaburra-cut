import {
  ALL_PROJECTS,
  filterProjectLibrary,
  type ProjectGroupRow,
  projectGroupRows,
} from "../ui/projectLibrary";
import type { SelectableItem } from "./types";

/** One block of the export picker's Projects list: a welcome-rail group row and every project in it. */
export interface ProjectGroupSection {
  row: ProjectGroupRow;
  items: SelectableItem[];
}

/** The welcome rail's group order, each keeping the catalogue's order; empty groups drop out. */
export function groupProjectItems(items: SelectableItem[]): ProjectGroupSection[] {
  const projects = items.map((item) => ({ ...item, group: item.group ?? null }));
  return projectGroupRows(projects)
    .filter((row) => row.id !== ALL_PROJECTS)
    .map((row) => ({ row, items: filterProjectLibrary(projects, row.id, "") }))
    .filter((section) => section.items.length > 0);
}

/** Matches the name, slug or group; an empty query keeps everything. */
export function matchesPackSearch(item: SelectableItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [item.name, item.slug, item.group ?? ""].some((field) =>
    field.toLocaleLowerCase().includes(needle),
  );
}
