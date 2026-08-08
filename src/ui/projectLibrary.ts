import type { WorkspaceProjectInfo } from "../engine/workspace";

export const ALL_PROJECTS = "all";
export const UNGROUPED_PROJECTS = "ungrouped";
const GROUP_PREFIX = "group:";

export interface ProjectGroupRow {
  id: string;
  label: string;
  count: number;
}

type ProjectLibraryItem = Pick<WorkspaceProjectInfo, "group" | "name" | "slug">;

export function projectGroupRows(projects: ProjectLibraryItem[]): ProjectGroupRow[] {
  const counts = new Map<string, number>();
  let ungrouped = 0;

  for (const project of projects) {
    if (project.group) counts.set(project.group, (counts.get(project.group) ?? 0) + 1);
    else ungrouped += 1;
  }

  return [
    { id: ALL_PROJECTS, label: "All", count: projects.length },
    { id: UNGROUPED_PROJECTS, label: "Ungrouped", count: ungrouped },
    ...Array.from(counts, ([label, count]) => ({
      id: `${GROUP_PREFIX}${label}`,
      label,
      count,
    })).sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

export function filterProjectLibrary<T extends ProjectLibraryItem>(
  projects: T[],
  groupId: string,
  query: string,
): T[] {
  const group = selectedProjectGroup(groupId);
  const trimmedQuery = query.trim().toLocaleLowerCase();

  return projects.filter((project) => {
    const inGroup =
      groupId === ALL_PROJECTS ||
      (groupId === UNGROUPED_PROJECTS ? !project.group : project.group === group);
    const matchesQuery =
      !trimmedQuery ||
      project.name.toLocaleLowerCase().includes(trimmedQuery) ||
      project.slug.toLocaleLowerCase().includes(trimmedQuery);
    return inGroup && matchesQuery;
  });
}

export function selectedProjectGroup(groupId: string): string | undefined {
  return groupId.startsWith(GROUP_PREFIX) ? groupId.slice(GROUP_PREFIX.length) : undefined;
}
