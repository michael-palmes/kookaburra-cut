import { invoke } from "@tauri-apps/api/core";
import type { FontIssue, SceneLoadError } from "./loadDiagnostics";
import { isWorkspaceProjectId, type LoadedProject, nativeProjectSlug } from "./project";

/** The editor's half of the `_bridge/app.json` heartbeat (docs/agent-kit.md): every load attempt is reported so `kb status` can say why a project opened degraded or not at all. Rust writes the file on the editor's one-second tick. */

/** Mirror of bridge.rs's LastLoad. */
export interface LastLoadReport {
  project: string;
  ok: boolean;
  atMs: number;
  error: string | null;
  sceneErrors: SceneLoadError[];
  fontIssues: FontIssue[];
  warnings: string[];
}

export function lastLoadReport(
  projectId: string,
  outcome:
    | { loaded: Pick<LoadedProject, "sceneErrors" | "fontIssues" | "healedSceneIds"> }
    | { error: unknown },
  atMs: number,
): LastLoadReport {
  if ("error" in outcome) {
    const error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return {
      project: projectId,
      ok: false,
      atMs,
      error,
      sceneErrors: [],
      fontIssues: [],
      warnings: [],
    };
  }
  const { loaded } = outcome;
  return {
    project: projectId,
    ok: true,
    atMs,
    error: null,
    sceneErrors: loaded.sceneErrors ?? [],
    fontIssues: loaded.fontIssues ?? [],
    warnings: (loaded.healedSceneIds ?? []).map(
      (file) => `${file} shared its scene id with another scene, so it was given a new one`,
    ),
  };
}

/** Best effort: a heartbeat that misses one load is stale, not wrong. */
export function reportLastLoad(report: LastLoadReport): void {
  void invoke("set_last_load", { load: report }).catch(() => {});
}

/** Re-stamp the project's Claude Code kit; native, off the main thread, never awaited by the load. */
export function stampProjectKit(projectId: string): void {
  if (!isWorkspaceProjectId(projectId)) return;
  void invoke("provision_project", { slug: nativeProjectSlug(projectId) }).catch((e) =>
    console.warn("[kit] stamp failed:", e),
  );
}
