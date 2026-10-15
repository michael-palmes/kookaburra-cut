import type { LoadedProject } from "./project";
import type { SceneDoc } from "./sceneDocSchema";

/** Live edits (docs/agent-kit.md): files are the source of truth, so every app write to a sidecar or `project.json` carries the content hash it was based on and Rust refuses it (`conflict:`) when the file changed outside the app. This module remembers the hash each in-memory scene document was read or written at, tells conflicts from failures, and tells the editor when an outside change surfaced. */

/** The base for a file the writer expects not to exist yet (Rust `ABSENT_BASE`). */
export const ABSENT_BASE = "absent";

const CONFLICT_PREFIX = "conflict:";

/** One app write as Rust reports it (`live_edits::FileWrite`). */
export interface FileWrite {
  /** Project-relative path: `project.json` or `scenes/<stem>.json`. */
  file: string;
  hash: string;
  /** The stamp the write replaced; null when the file was new. */
  before: string | null;
  stamp: string;
}

/** A write refused because its file changed outside the app; the message names the file. */
export class WriteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteConflictError";
  }
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** The conflict a failed write carries, or null for any other failure. */
export function asWriteConflict(e: unknown): WriteConflictError | null {
  if (e instanceof WriteConflictError) return e;
  const text = errorText(e);
  if (!text.startsWith(CONFLICT_PREFIX)) return null;
  return new WriteConflictError(text.slice(CONFLICT_PREFIX.length).trim());
}

export function isWriteConflict(e: unknown): boolean {
  return asWriteConflict(e) !== null;
}

/** Lowercase hex SHA-256 of the text's UTF-8 bytes: the same value Rust gives the file holding exactly this text. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Keyed by document identity, so a stale document keeps its stale hash and can never pass for fresh.
const docHashes = new WeakMap<object, string>();

export function rememberSceneDocHash(doc: SceneDoc, hash: string): void {
  docHashes.set(doc, hash);
}

/** An unwritten preview derived from `from` stands on the same disk version, so a later write from it is checked like one from `from`. */
export function inheritSceneDocBase(next: SceneDoc, from: SceneDoc | null | undefined): void {
  const hash = from ? docHashes.get(from) : ABSENT_BASE;
  if (hash !== undefined) docHashes.set(next, hash);
}

/** The base a write derived from `doc` must carry: the hash it was read or written at, `absent` for a scene with no sidecar, undefined when unknown (the write goes unchecked). */
export function sceneDocBase(doc: SceneDoc | null | undefined): string | undefined {
  if (!doc) return ABSENT_BASE;
  return docHashes.get(doc);
}

const APP_HASH_LIMIT = 512;
const appHashes = new Set<string>();

/** Remember content the app itself wrote, so a refused write over the app's own newer bytes rebases quietly instead of reporting an outside change. */
export function noteAppHash(hash: string): void {
  appHashes.delete(hash);
  appHashes.add(hash);
  if (appHashes.size > APP_HASH_LIMIT) {
    const oldest = appHashes.values().next().value;
    if (oldest !== undefined) appHashes.delete(oldest);
  }
}

export function isAppHash(hash: string | undefined): boolean {
  return hash !== undefined && appHashes.has(hash);
}

/** What the app did about an outside change it ran into: rebuilt the edit on the new file, dropped it, or found nothing left to write. */
export type OutsideChangeAction = "rebased" | "dropped" | "reloaded";

export interface OutsideChange {
  slug: string;
  /** Project-relative paths that changed. */
  files: string[];
  action: OutsideChangeAction;
  /** What was dropped, for the toast ("Undo", "Redo"); an edit otherwise. */
  what?: string;
}

type OutsideChangeListener = (change: OutsideChange) => void;
const listeners = new Set<OutsideChangeListener>();

/** The editor listens here to reload (so memory matches disk) and say what happened. */
export function onOutsideChange(listener: OutsideChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportOutsideChange(change: OutsideChange): void {
  for (const listener of listeners) listener(change);
}

/** The toast for an outside change; `label` names the scene (quoted) or the file. */
export function outsideChangeMessage(change: OutsideChange, label: string): string {
  const changed = `${label} changed outside the app`;
  if (change.action === "rebased") return `${changed}. Your edit was applied on top. Reloaded.`;
  if (change.action === "dropped") return `${change.what ?? "Edit"} skipped: ${changed}. Reloaded.`;
  return `${changed}. Reloaded.`;
}

/** The changed scene's name in quotes for a single sidecar, else the file (or files). */
export function outsideChangeLabel(
  files: readonly string[],
  project: Pick<LoadedProject, "sceneFiles" | "sceneDocs">,
): string {
  if (files.length !== 1) return files.join(", ");
  const [file] = files;
  const index = project.sceneFiles.findIndex(
    (f) => f.replace(/^\.?\//, "").replace(/\.tsx$/, ".json") === file,
  );
  if (index < 0) return file;
  const name = project.sceneDocs[index]?.name?.trim();
  return `“${name || `Scene ${index + 1}`}”`;
}
