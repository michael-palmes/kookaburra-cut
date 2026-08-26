/** Post-import review of terminal blocks in the projects a pack just wrote: every pre-typed command and custom start path, surfaced on the summary screen so a file shared by someone else is reviewed before a session ever starts. Reads the landed sidecars off disk (what landed is what matters, never the archive or the publisher's manifest); any read failure degrades to no rows, since the summary must never fail on a review. */

import { invoke } from "@tauri-apps/api/core";
import { readProjectManifestSnapshot } from "../../engine/projectEdit";
import { parseSceneTerminal } from "../../engine/sceneTerminal";
import type { ImportOutcome } from "../types";

export interface TerminalReviewRow {
  project: string;
  /** The sidecar's scene name, else the file stem (the perfProbe label pattern). */
  scene: string;
  /** The scene file, for stable React keys. */
  file: string;
  command: string | null;
  startPath: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure collector over one project's raw sidecar JSON values. */
export function terminalReviewRows(
  project: string,
  scenes: { file: string; doc: unknown }[],
): TerminalReviewRow[] {
  const rows: TerminalReviewRow[] = [];
  for (const { file, doc } of scenes) {
    if (!isRecord(doc) || doc.terminal === undefined) continue;
    const terminal = parseSceneTerminal(doc.terminal, `${project}/${file}`);
    const command = terminal?.startCommand ?? null;
    const startPath = terminal?.startPath ?? null;
    if (!command && !startPath) continue;
    const name = typeof doc.name === "string" ? doc.name.trim() : "";
    const scene = name || file.replace(/^scenes\//, "").replace(/\.tsx$/, "");
    rows.push({ project, scene, file, command, startPath });
  }
  return rows;
}

/** Rows for every project the import landed (added, replaced or kept-both under its final slug). */
export async function reviewImportedTerminals(
  outcome: ImportOutcome,
): Promise<TerminalReviewRow[]> {
  const projects = outcome.results.filter(
    (r) =>
      r.kind === "project" &&
      (r.outcome === "added" || r.outcome === "replaced" || r.outcome === "keptBoth"),
  );
  const rows: TerminalReviewRow[] = [];
  for (const project of projects) {
    try {
      const manifest = JSON.parse(await readProjectManifestSnapshot(project.slug)) as {
        scenes?: { file?: unknown }[];
      };
      const files = (manifest.scenes ?? [])
        .map((s) => s?.file)
        .filter((f): f is string => typeof f === "string" && f.endsWith(".tsx"));
      const scenes: { file: string; doc: unknown }[] = [];
      for (const file of files) {
        const text = await invoke<string | null>("read_scene_doc", {
          slug: project.slug,
          file: file.replace(/\.tsx$/, ".json"),
        });
        if (text != null) scenes.push({ file, doc: JSON.parse(text) });
      }
      rows.push(...terminalReviewRows(project.name, scenes));
    } catch (e) {
      console.warn(`[packs] terminal review for "${project.slug}" failed:`, e);
    }
  }
  return rows;
}
