import { invoke } from "@tauri-apps/api/core";
import type { HistoryChange, HistoryEntry } from "./history";
import { contentHash, isWriteConflict } from "./sceneDocBase";

/** Undo and redo replay whole snapshots, which can't merge: an entry whose file changed outside the app since the entry last landed is refused before anything is written, so a replay never writes over a change it never saw. */

const MANIFEST = "project.json";

/** The source file a change writes, project-relative. */
export function historyChangeFile(change: HistoryChange): string {
  return change.kind === "sceneDoc" ? change.file.replace(/\.tsx$/, ".json") : MANIFEST;
}

/** What the file must hold before `change` replays: the hash it last left, or for a manifest change never replayed, the hash of its recorded `after`. */
async function expectedHash(
  change: HistoryChange,
  dir: "undo" | "redo",
): Promise<string | undefined> {
  if (change.hash !== undefined) return change.hash;
  if (change.kind === "manifest") return contentHash(dir === "undo" ? change.after : change.before);
  return undefined;
}

export type ReplayOutcome = { status: "done" } | { status: "conflict"; files: string[] };

/** Writes one change against `baseHash`; resolves the hash it left, if known. */
export type ReplayWrite = (
  change: HistoryChange,
  dir: "undo" | "redo",
  baseHash: string | undefined,
) => Promise<string | undefined>;

export type SourceHashes = (slug: string, files: string[]) => Promise<string[]>;

const projectFileHashes: SourceHashes = (slug, files) =>
  invoke<string[]>("project_file_hashes", { slug, files });

/** Replay an entry: every file it touches is checked first (all or nothing), then each change writes against the hash its file holds, and records the hash it leaves for the next replay. */
export async function replayHistoryEntry(
  entry: HistoryEntry,
  dir: "undo" | "redo",
  write: ReplayWrite,
  hashesOf: SourceHashes = projectFileHashes,
): Promise<ReplayOutcome> {
  const ordered = dir === "undo" ? [...entry.changes].reverse() : entry.changes;
  const key = (change: HistoryChange) => `${change.slug}\u0000${historyChangeFile(change)}`;
  const firsts = new Map<string, { slug: string; file: string; expected: string | undefined }>();
  for (const change of ordered) {
    if (firsts.has(key(change))) continue;
    firsts.set(key(change), {
      slug: change.slug,
      file: historyChangeFile(change),
      expected: await expectedHash(change, dir),
    });
  }

  const conflicts: string[] = [];
  const checked = [...firsts.values()].filter((first) => first.expected !== undefined);
  for (const slug of new Set(checked.map((first) => first.slug))) {
    const mine = checked.filter((first) => first.slug === slug);
    const hashes = await hashesOf(
      slug,
      mine.map((first) => first.file),
    );
    mine.forEach((first, i) => {
      if (hashes[i] !== first.expected) conflicts.push(first.file);
    });
  }
  if (conflicts.length > 0) return { status: "conflict", files: conflicts };

  // A file touched twice in one entry is based on what this replay just wrote.
  const left = new Map<string, string | undefined>();
  for (const change of ordered) {
    const k = key(change);
    const base = left.has(k) ? left.get(k) : firsts.get(k)?.expected;
    let hash: string | undefined;
    try {
      hash = await write(change, dir, base);
    } catch (e) {
      if (isWriteConflict(e)) return { status: "conflict", files: [historyChangeFile(change)] };
      throw e;
    }
    left.set(k, hash);
    if (hash !== undefined) change.hash = hash;
  }
  return { status: "done" };
}

/** Whether an entry writes any of these project-relative files of `slug`. */
export function historyEntryTouches(
  entry: HistoryEntry,
  slug: string,
  files: readonly string[],
): boolean {
  return entry.changes.some(
    (change) => change.slug === slug && files.includes(historyChangeFile(change)),
  );
}
