import type { WorkspaceProjectInfo } from "../engine/workspace";
import type { LibraryKind, LibrarySource } from "./libraryDetails";
import type { LibraryRailIconId } from "./libraryIcons";

export const ALL_PROJECTS = "all";
export const UNGROUPED_PROJECTS = "ungrouped";
const GROUP_PREFIX = "group:";

/** The welcome rail's library rows: the user's own catalogues, then the bundled ones a dev checkout may edit. */
export const LIBRARY_TEMPLATES = "library:templates";
export const LIBRARY_PRESETS = "library:presets";
export const LIBRARY_APP_TEMPLATES = "library:app-templates";
export const LIBRARY_APP_PRESETS = "library:app-presets";

export interface ProjectGroupRow {
  id: string;
  label: string;
  count: number;
  iconId: LibraryRailIconId;
}

/** Which catalogue a library row shows. */
export interface LibrarySection {
  kind: LibraryKind;
  source: LibrarySource;
}

const LIBRARY_SECTIONS: Record<string, LibrarySection> = {
  [LIBRARY_TEMPLATES]: { kind: "template", source: "user" },
  [LIBRARY_PRESETS]: { kind: "preset", source: "user" },
  [LIBRARY_APP_TEMPLATES]: { kind: "template", source: "bundled" },
  [LIBRARY_APP_PRESETS]: { kind: "preset", source: "bundled" },
};

/** null for the project rows, which show the project grid instead. */
export function librarySection(rowId: string): LibrarySection | null {
  return LIBRARY_SECTIONS[rowId] ?? null;
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
    { id: ALL_PROJECTS, label: "All", count: projects.length, iconId: "all" },
    { id: UNGROUPED_PROJECTS, label: "Ungrouped", count: ungrouped, iconId: "ungrouped" },
    ...Array.from(counts, ([label, count]) => ({
      id: `${GROUP_PREFIX}${label}`,
      label,
      count,
      iconId: "group" as const,
    })).sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

/** Live counts behind the library rows. */
export interface LibraryCounts {
  templates: number;
  presets: number;
  appTemplates: number;
  appPresets: number;
}

export function libraryRows(counts: LibraryCounts, showApp: boolean): ProjectGroupRow[] {
  const rows: ProjectGroupRow[] = [
    { id: LIBRARY_TEMPLATES, label: "Templates", count: counts.templates, iconId: "templates" },
    { id: LIBRARY_PRESETS, label: "Presets", count: counts.presets, iconId: "presets" },
  ];
  if (showApp) {
    rows.push(
      {
        id: LIBRARY_APP_TEMPLATES,
        label: "App templates",
        count: counts.appTemplates,
        iconId: "app-templates",
      },
      {
        id: LIBRARY_APP_PRESETS,
        label: "App presets",
        count: counts.appPresets,
        iconId: "app-presets",
      },
    );
  }
  return rows;
}

export interface WelcomeRailSection {
  id: "projects" | "library";
  label: string;
  rows: ProjectGroupRow[];
}

/** The whole rail: the project groups, then the catalogues. One list so the roving keyboard focus crosses both headings without knowing they exist. */
export function welcomeRailSections(
  projects: ProjectLibraryItem[],
  counts: LibraryCounts,
  showApp: boolean,
): WelcomeRailSection[] {
  return [
    { id: "projects", label: "Projects", rows: projectGroupRows(projects) },
    { id: "library", label: "Library", rows: libraryRows(counts, showApp) },
  ];
}

export function welcomeRailRows(sections: WelcomeRailSection[]): ProjectGroupRow[] {
  return sections.flatMap((section) => section.rows);
}

/** Roving arrow-key movement over the flattened rail; null for a key the rail does not own. */
export function nextWelcomeRailRow(
  rows: ProjectGroupRow[],
  currentId: string,
  key: string,
): { id: string; index: number } | null {
  if (rows.length === 0) return null;
  const current = Math.max(
    0,
    rows.findIndex((row) => row.id === currentId),
  );
  let next = current;
  if (key === "ArrowDown" || key === "ArrowRight") next = Math.min(rows.length - 1, current + 1);
  else if (key === "ArrowUp" || key === "ArrowLeft") next = Math.max(0, current - 1);
  else if (key === "Home") next = 0;
  else if (key === "End") next = rows.length - 1;
  else return null;
  return { id: rows[next].id, index: next };
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
