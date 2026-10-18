import { invoke } from "@tauri-apps/api/core";
import { AVAILABLE_DEVICE_IDS } from "../toolkit/device/catalog";
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
  /** Device ids this build renders with their own model; `kb check` warns on the rest, which render as Android. */
  availableDevices?: string[];
}

export function lastLoadReport(
  projectId: string,
  outcome:
    | {
        loaded: Pick<
          LoadedProject,
          "sceneErrors" | "fontIssues" | "healedSceneIds" | "loadWarnings"
        >;
      }
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
    warnings: [
      ...(loaded.healedSceneIds ?? []).map(
        (file) => `${file} shared its scene id with another scene, so it was given a new one`,
      ),
      ...(loaded.loadWarnings ?? []),
    ],
  };
}

/** Best effort: a heartbeat that misses one load is stale, not wrong. */
export function reportLastLoad(report: LastLoadReport): void {
  const load = {
    ...report,
    availableDevices: report.availableDevices ?? [...AVAILABLE_DEVICE_IDS],
  };
  void invoke("set_last_load", { load }).catch(() => {});
}

const stampedThisSession = new Set<string>();

/** Re-stamp the project's Claude Code kit once per project per app session (every live reload is a load, and each save would otherwise re-walk the kit); native, off the main thread, never awaited by the load. A failed stamp retries on the next load. */
export function stampProjectKit(projectId: string): void {
  if (!isWorkspaceProjectId(projectId)) return;
  const slug = nativeProjectSlug(projectId);
  if (stampedThisSession.has(slug)) return;
  stampedThisSession.add(slug);
  void invoke("provision_project", { slug }).catch((e) => {
    stampedThisSession.delete(slug);
    console.warn("[kit] stamp failed:", e);
  });
}
