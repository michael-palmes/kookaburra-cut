import { isWorkspaceProjectId, type LoadedProject, sceneFileStem } from "./project";
import { commitSceneDocPatch, type DocChangedHandler } from "./sceneDocPatchQueue";
import type { SceneDocTerminalSnapshot } from "./sceneTerminal";
import { resolveSceneTerminal, terminalSnapshotStale } from "./sceneTerminal";
import { bakeTerminalSnapshot } from "./sceneTerminalBake";
import { resolveTerminalColours } from "./sceneTerminalTheme";
import { layoutTranscript } from "./sceneTerminalTranscript";

/** Keeps each terminal's PNG in step with its sidecar, in the editor only (export and preview never rasterise). A transcript newer than its snapshot (an agent's write) lays out and bakes, then lands the grid with no history entry of its own; an inspector edit lands its grid in its own write (`landTranscriptSnapshot`), so undo's file hash still matches, and anything else that changes the pixels (that edit, an undo, a re-theme) re-bakes them alone. The first sight of a settled snapshot leaves its PNG untouched. */

interface Job {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: DocChangedHandler;
}

/** What the PNG on disk shows, per project and scene. */
const baked = new Map<string, string>();
const wanted = new Map<string, Job & { print: string }>();
const baking = new Map<string, string>();
const running = new Map<string, Promise<void>>();

function plan({ project, sceneIndex }: Pick<Job, "project" | "sceneIndex">) {
  const doc = project.sceneDocs[sceneIndex];
  const terminal = resolveSceneTerminal(doc);
  if (!doc?.terminal || !terminal) return null;
  const stale = terminalSnapshotStale(doc.terminal);
  const snapshot: SceneDocTerminalSnapshot | null =
    stale && terminal.transcript
      ? {
          ...layoutTranscript(terminal.transcript, terminal.cols, terminal.rows),
          transcript: terminal.transcript,
        }
      : terminal.snapshot;
  if (!snapshot) return null;
  const theme = project.sceneThemes[sceneIndex] ?? project.theme;
  const print = JSON.stringify([
    snapshot.grid,
    snapshot.cursor,
    terminal.cols,
    terminal.rows,
    terminal.fontPx,
    resolveTerminalColours(terminal.theme, theme),
  ]);
  return { terminal, theme, snapshot, stale, print };
}

async function bakeOne(key: string, job: Job): Promise<void> {
  const step = plan(job);
  if (!step) return;
  const { project, sceneIndex, onDocChanged } = job;
  const stem = sceneFileStem(project.sceneFiles[sceneIndex] ?? "");
  const { terminal, theme, snapshot, print } = step;
  const src = await bakeTerminalSnapshot(project.id, stem, { ...terminal, snapshot }, theme);
  baked.set(key, print);
  if (snapshot.src === src && !step.stale) return;
  await commitSceneDocPatch({ project, sceneIndex, label: false, onDocChanged }, (next) => {
    // A newer edit wins: its own doc change brings it back through here.
    if (!next.terminal || (next.terminal.transcript ?? null) !== terminal.transcript) return false;
    next.terminal.snapshot = { ...snapshot, src };
  });
}

async function drain(key: string): Promise<void> {
  for (let job = wanted.get(key); job; job = wanted.get(key)) {
    wanted.delete(key);
    baking.set(key, job.print);
    try {
      await bakeOne(key, job);
    } catch (e) {
      console.warn("[terminal] snapshot bake failed:", e);
    }
    baking.delete(key);
  }
  running.delete(key);
}

/** Runs off every project change in the main window, never during an export. */
export function reconcileTerminalBakes(
  project: LoadedProject,
  onDocChanged: DocChangedHandler,
): void {
  if (!isWorkspaceProjectId(project.id)) return;
  project.sceneDocs.forEach((_, sceneIndex) => {
    const file = project.sceneFiles[sceneIndex];
    if (!file) return;
    const key = `${project.id}\u0000${file}`;
    const step = plan({ project, sceneIndex });
    if (!step) {
      // Seen with nothing baked, so the first snapshot an edit lands isn't taken for a settled one.
      if (project.sceneDocs[sceneIndex]?.terminal && !baked.has(key)) baked.set(key, "");
      return;
    }
    if (!step.stale && step.snapshot.src) {
      if (!baked.has(key)) baked.set(key, step.print);
      if (baked.get(key) === step.print) return;
    }
    if (baking.get(key) === step.print && !wanted.has(key)) return;
    if (wanted.get(key)?.print === step.print) return;
    wanted.set(key, { project, sceneIndex, onDocChanged, print: step.print });
    if (!running.has(key)) running.set(key, drain(key));
  });
}

/** Lets an export or reload start from pixels that match the sidecars. */
export async function settleTerminalBakes(): Promise<void> {
  while (running.size > 0) await Promise.all(running.values());
}
