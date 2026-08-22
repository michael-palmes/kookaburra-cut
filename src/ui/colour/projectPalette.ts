import type { LoadedProject } from "../../engine/project";
import { normaliseHex } from "./colourUtils";

/** The colours a loaded project already commits to, so a deck stays internally consistent without anyone copying hex codes between scenes. Scanned lazily and memoised per project identity: `handleDocChanged` mints a new `LoadedProject` on every sidecar write, so an eager scan would run inside the very interaction that opened the picker. */

/** Two full grid rows: enough to be a palette, short enough to stay a glance. */
export const PROJECT_PALETTE_CAP = 24;

/** The authored fields that carry colour; resolved themes and derived compare docs are deliberately out (the Theme section covers the first, the second would double-count). */
type PaletteSource = Pick<
  LoadedProject,
  | "sceneDocs"
  | "deckFrame"
  | "projectLighting"
  | "effects"
  | "effectOverrides"
  | "sceneEffectDefaults"
>;

function walk(value: unknown, counts: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, counts);
    return;
  }
  if (typeof value === "string") {
    // Authored colours always carry the #; normaliseHex makes it optional, which reads "Feb" as #ffeebb.
    const hex = value.startsWith("#") ? normaliseHex(value) : null;
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const entry of Object.values(value)) walk(entry, counts);
}

/** Every authored colour in a loaded project, most-used first (ties keep first-seen order). */
export function collectProjectColours(project: PaletteSource | null): string[] {
  if (!project) return [];
  const counts = new Map<string, number>();
  walk(
    [
      project.sceneDocs,
      project.deckFrame,
      project.projectLighting,
      project.effects,
      project.effectOverrides,
      project.sceneEffectDefaults,
    ],
    counts,
  );
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PROJECT_PALETTE_CAP)
    .map(([hex]) => hex);
}

let source: LoadedProject | null = null;
const cache = new WeakMap<LoadedProject, string[]>();

/** The current project, set once per project identity by App. */
export function setProjectPaletteSource(project: LoadedProject | null): void {
  source = project;
}

/** The cached scan for the current source; [] when no project is loaded. */
export function projectPaletteColours(): string[] {
  if (!source) return [];
  const cached = cache.get(source);
  if (cached) return cached;
  const colours = collectProjectColours(source);
  cache.set(source, colours);
  return colours;
}
