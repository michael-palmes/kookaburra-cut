import { nameCollision } from "../engine/nameCollision";
import type { ThemeChoice } from "./ThemePicker";

/** The wizard's first card: creates from the blank template, with the Claude Code panel open as it is for every editable project. */
export const CLAUDE_START_ID = "create-with-claude";

export const DEFAULT_THEME_ID = "kookaburra-studio-white";

const CLAUDE_START_HAYSTACK = "create with claude describe blank empty scratch start";

/** The Start grid is three columns; the Claude card, when shown, spans the first two. */
export const START_GRID_COLUMNS = 3;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-10-22 - New Project`, numbered on from 2 when today's name is already a project. */
export function defaultProjectName(now: Date, takenSlugs: readonly string[]): string {
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} - New Project`;
  if (!nameCollision(base, takenSlugs).collides) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!nameCollision(name, takenSlugs).collides) return name;
  }
}

export function claudeStartMatches(query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => CLAUDE_START_HAYSTACK.includes(term));
}

/** Arrow-key movement over the Start grid, where a leading Claude card fills two cells. Returns the next index, or null for keys the grid does not handle. */
export function startGridStep(
  key: string,
  index: number,
  count: number,
  leadSpansTwo: boolean,
  meta = false,
): number | null {
  const handled = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
  if (!handled.includes(key) || count === 0) return null;
  if (index < 0) return 0;
  const cellOf = (i: number) => (leadSpansTwo && i > 0 ? i + 1 : i);
  const indexOf = (cell: number) => {
    const i = leadSpansTwo ? (cell <= 1 ? 0 : cell - 1) : cell;
    return Math.min(count - 1, Math.max(0, i));
  };
  const cell = cellOf(index);
  const rowStart = cell - (cell % START_GRID_COLUMNS);
  switch (key) {
    case "ArrowRight":
      return Math.min(count - 1, index + 1);
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowDown":
      return cellOf(count - 1) < cell + START_GRID_COLUMNS
        ? count - 1
        : indexOf(cell + START_GRID_COLUMNS);
    case "ArrowUp":
      return cell < START_GRID_COLUMNS ? index : indexOf(cell - START_GRID_COLUMNS);
    case "Home":
      return meta ? 0 : indexOf(rowStart);
    default:
      return meta ? count - 1 : indexOf(rowStart + START_GRID_COLUMNS - 1);
  }
}

export type LookFilter = "all" | "yours" | "light" | "dark";

/** The Look step's listing: the user's own themes lead, then the bundled catalogue, narrowed by the filter chip. */
export function lookChoices(choices: readonly ThemeChoice[], filter: LookFilter): ThemeChoice[] {
  const ordered = [
    ...choices.filter(({ source }) => source === "workspace"),
    ...choices.filter(({ source }) => source !== "workspace"),
  ];
  if (filter === "yours") return ordered.filter(({ source }) => source === "workspace");
  if (filter === "light" || filter === "dark") return ordered.filter(({ mode }) => mode === filter);
  return ordered;
}

/** The user's first own theme when they have one, the app default otherwise. */
export function initialLookThemeId(choices: readonly ThemeChoice[]): string {
  return choices.find(({ source }) => source === "workspace")?.id ?? DEFAULT_THEME_ID;
}
