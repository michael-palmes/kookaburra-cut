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

type ProjectRecencyItem = Pick<WorkspaceProjectInfo, "name" | "lastOpenedMs">;

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

/** Most-recently-opened first, ties (and never-opened projects) by name. Returns a new array; the welcome screen and the copy-to-project drill share this one order. */
export function sortProjectsByRecency<T extends ProjectRecencyItem>(projects: T[]): T[] {
  return [...projects].sort(
    (a, b) => (b.lastOpenedMs ?? 0) - (a.lastOpenedMs ?? 0) || a.name.localeCompare(b.name),
  );
}

/** The card's relative "Opened …" line; null when the project has never been opened. */
export function formatLastOpened(ms: number | null): string | null {
  if (!ms) return null;
  const elapsed = Date.now() - ms;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "Opened just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) return `Opened ${rtf.format(-minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Opened ${rtf.format(-hours, "hour")}`;
  return `Opened ${rtf.format(-Math.round(hours / 24), "day")}`;
}

/** Restrained line-art placeholder for cards with no snapshot yet (no emoji, §3.12). */
export function PlaceholderArt() {
  return (
    <svg width="72" height="44" viewBox="0 0 72 44" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="69"
        height="41"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M30 15.5v13l11.5-6.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
