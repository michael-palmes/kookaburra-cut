import type { SceneLoadError } from "./loadDiagnostics";

const HEADLINE_MAX_CHARS = 200;

/** The first non-empty line of an error, clipped for a card or a one-line list. */
export function errorHeadline(message: string): string {
  const line = message
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > HEADLINE_MAX_CHARS ? `${line.slice(0, HEADLINE_MAX_CHARS - 1)}…` : line;
}

/** What a load degraded around that a deliverable must not ship with: error cards, plus `exportBlockers` (a dropped LUT, an unreadable font file), each a clause that reads after "while". */
export interface LoadProblems {
  sceneErrors?: readonly SceneLoadError[];
  exportBlockers?: readonly string[];
}

/** Null when the project loaded whole, else why `action` can't run, naming each broken file and blocker. Export, stills and autorun gates refuse on it so a degraded load never reaches a deliverable. */
export function sceneErrorRefusal(project: LoadProblems, action: string): string | null {
  const reasons: string[] = [];
  const sceneErrors = project.sceneErrors ?? [];
  if (sceneErrors.length) {
    const count = sceneErrors.length === 1 ? "a file" : `${sceneErrors.length} files`;
    const list = sceneErrors
      .map((error) => `${error.file} (${error.phase}): ${errorHeadline(error.message)}`)
      .join("; ");
    reasons.push(`${count} can't load: ${list}`);
  }
  reasons.push(...(project.exportBlockers ?? []));
  return reasons.length ? `Can't ${action} while ${reasons.join("; ")}` : null;
}

export function assertScenesLoaded(project: LoadProblems, action: string): void {
  const refusal = sceneErrorRefusal(project, action);
  if (refusal) throw new Error(refusal);
}
