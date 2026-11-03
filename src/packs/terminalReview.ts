/** Review of terminal blocks in scene sidecars for the export picker, which warns that transcripts and snapshots travel with the pack (read off disk; a read failure degrades to no rows, since the picker may not fail on a review). */

import { invoke } from "@tauri-apps/api/core";
import { readProjectManifestSnapshot } from "../engine/projectEdit";
import { parseSceneTerminal } from "../engine/sceneTerminal";

export interface TerminalReviewRow {
  project: string;
  /** The sidecar's scene name, else the file stem (the perfProbe label pattern). */
  scene: string;
  /** The scene file, for stable React keys. */
  file: string;
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
    if (!terminal?.transcript && !terminal?.snapshot) continue;
    const name = typeof doc.name === "string" ? doc.name.trim() : "";
    const scene = name || file.replace(/^scenes\//, "").replace(/\.tsx$/, "");
    rows.push({ project, scene, file });
  }
  return rows;
}

/** Rows for the named workspace projects, read from their on-disk sidecars. */
export async function reviewProjectTerminals(
  projects: { slug: string; name: string }[],
): Promise<TerminalReviewRow[]> {
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
