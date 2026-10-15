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

/** Null when every scene loaded, else why `action` can't run, naming each file and its error. Export, stills and autorun gates refuse on it so an error card never reaches a deliverable. */
export function sceneErrorRefusal(
  sceneErrors: readonly SceneLoadError[] | undefined,
  action: string,
): string | null {
  if (!sceneErrors?.length) return null;
  const count = sceneErrors.length === 1 ? "a file" : `${sceneErrors.length} files`;
  const list = sceneErrors
    .map((error) => `${error.file} (${error.phase}): ${errorHeadline(error.message)}`)
    .join("; ");
  return `Can't ${action} while ${count} can't load: ${list}`;
}

export function assertScenesLoaded(
  project: { sceneErrors?: readonly SceneLoadError[] },
  action: string,
): void {
  const refusal = sceneErrorRefusal(project.sceneErrors, action);
  if (refusal) throw new Error(refusal);
}
