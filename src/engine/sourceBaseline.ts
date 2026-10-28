import { invoke } from "@tauri-apps/api/core";
import type { FileWrite } from "./sceneDocBase";

/** The editor's reload poll keeps one stamp per source file (`project.json`, `scenes/**`). An app write moves only its own file's entry, and only while that entry still holds the stamp the write replaced, so an outside change landing in the same window still reloads. */

export interface SourceStamp {
  file: string;
  stamp: string;
}

interface BaselineState {
  slug: string;
  stamps: Map<string, string> | null;
  /** The settled-change key seen on the previous tick: a change reloads once it reads the same twice. */
  pending: string | null;
}

let state: BaselineState | null = null;

export function projectFileStamps(slug: string): Promise<SourceStamp[]> {
  return invoke<SourceStamp[]>("project_file_stamps", { slug });
}

/** Bind the poll to a project. The same project keeps its baseline, so a poll paused for an export resumes against it and still sees what changed meanwhile. */
export function bindSourceBaseline(slug: string): void {
  if (state?.slug === slug) state.pending = null;
  else state = { slug, stamps: null, pending: null };
}

/** The poll's baseline for this project (null before its first tick); the bridge export waits until it matches the disk. */
export function sourceBaselineStamps(slug: string): ReadonlyMap<string, string> | null {
  return state?.slug === slug ? state.stamps : null;
}

/** Files whose stamp changed, appeared or disappeared, sorted. */
export function changedSourceFiles(
  baseline: ReadonlyMap<string, string>,
  current: readonly SourceStamp[],
): string[] {
  const changed = new Set<string>();
  const seen = new Set<string>();
  for (const { file, stamp } of current) {
    seen.add(file);
    if (baseline.get(file) !== stamp) changed.add(file);
  }
  for (const file of baseline.keys()) if (!seen.has(file)) changed.add(file);
  return [...changed].sort();
}

/** One poll tick: the outside-changed files once the same change has read identically on two ticks, else null. The first observation only sets the baseline. */
export function observeSourceStamps(
  slug: string,
  current: readonly SourceStamp[],
): string[] | null {
  if (!state || state.slug !== slug) return null;
  if (!state.stamps) {
    state.stamps = new Map(current.map((s) => [s.file, s.stamp]));
    return null;
  }
  const changed = changedSourceFiles(state.stamps, current);
  if (changed.length === 0) {
    state.pending = null;
    return null;
  }
  const byFile = new Map(current.map((s) => [s.file, s.stamp]));
  const key = changed.map((file) => `${file}=${byFile.get(file) ?? ""}`).join("\n");
  if (state.pending !== key) {
    state.pending = key;
    return null;
  }
  state.stamps = byFile;
  state.pending = null;
  return changed;
}

/** An app write landed: adopt its stamp when the baseline still held the one it replaced (no entry for a new file). Trust needs nothing here: the native writer re-stamped the grant. */
export function noteSourceWrite(slug: string, write: FileWrite | null | undefined): void {
  if (!write) return;
  if (!state || state.slug !== slug || !state.stamps) return;
  if ((state.stamps.get(write.file) ?? null) !== (write.before ?? null)) return;
  state.stamps.set(write.file, write.stamp);
}

/** For writers that report no stamp and are followed by a reload (which reads whatever an outside change left): adopt these files' current stamps. */
export async function armSourceFiles(slug: string, files: readonly string[]): Promise<void> {
  const current = await projectFileStamps(slug);
  if (!state || state.slug !== slug || !state.stamps) return;
  const byFile = new Map(current.map((s) => [s.file, s.stamp]));
  for (const file of files) {
    const stamp = byFile.get(file);
    if (stamp === undefined) state.stamps.delete(file);
    else state.stamps.set(file, stamp);
  }
}

export function resetSourceBaselineForTests(): void {
  state = null;
}
