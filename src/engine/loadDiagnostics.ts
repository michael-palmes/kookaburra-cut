/** Why a project loaded degraded: the shared record behind error cards, the bridge `check` response and the heartbeat's `lastLoad` (docs/agent-kit.md). */

export type SceneLoadPhase = "compile" | "evaluate" | "export" | "render";

export interface SceneLoadError {
  /** Manifest index of the scene. */
  index: number;
  /** Manifest module path, e.g. `scenes/02-hero.tsx`. */
  file: string;
  phase: SceneLoadPhase;
  message: string;
}

export interface FontIssue {
  /** The ref as authored, e.g. `Menlo@400`. */
  ref: string;
  message: string;
  /** The face rendered instead, or null when nothing could stand in. */
  fallback: string | null;
}

export interface LoadDiagnostics {
  project: string;
  sceneErrors: SceneLoadError[];
  fontIssues: FontIssue[];
  warnings: string[];
}

const renderErrors = new Map<string, SceneLoadError[]>();

/** Record an error a scene threw while rendering (caught by its boundary), once per scene and message. */
export function reportRenderError(projectId: string, error: Omit<SceneLoadError, "phase">): void {
  const list = renderErrors.get(projectId) ?? [];
  if (list.some((e) => e.index === error.index && e.message === error.message)) return;
  list.push({ ...error, phase: "render" });
  renderErrors.set(projectId, list);
}

export function projectRenderErrors(projectId: string): readonly SceneLoadError[] {
  return renderErrors.get(projectId) ?? [];
}

export function clearRenderErrors(projectId: string): void {
  renderErrors.delete(projectId);
}
