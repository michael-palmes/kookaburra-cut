import type { SceneDoc } from "./sceneDocSchema";

/** Session-only, per-project UNDO/REDO over the sidecar + project.json write surfaces; UI-only, the export path never reads this module. An entry is a LIST of atomic changes (e.g. a duration edit writes the sidecar AND the manifest, one ⌘Z reverts both) and replays through the SAME atomic writers the original edits used. Scene DELETE is deliberately absent (locked decision: the two-step + Trash is its safety net); the stack clears on project switch and capacity is bounded, the oldest entries fall off. */

export type HistoryChange =
  | {
      kind: "sceneDoc";
      slug: string;
      /** Manifest module path, e.g. `scenes/02-hero.tsx`. */
      file: string;
      sceneIndex: number;
      /** null = the sidecar didn't exist; undo restores an EMPTY doc (behaviourally identical - deleting files isn't a writer we have or need). */
      before: SceneDoc | null;
      after: SceneDoc | null;
      /** The change touched load-time-resolved state (themeId; sceneThemes/effect bases bake at load), so replaying needs the nonce reload, not just the in-memory patch. */
      reload?: boolean;
    }
  | {
      kind: "manifest";
      slug: string;
      /** Whole project.json snapshots; generic over every manifest op. */
      before: string;
      after: string;
      /** The scene SET/order changed (move); the executor must full-reload. */
      reload: boolean;
    };

export interface HistoryEntry {
  /** Human label for the toast: "Undid: <label>". */
  label: string;
  changes: HistoryChange[];
}

const CAPACITY = 50;

let projectId: string | null = null;
let entries: HistoryEntry[] = [];
/** Number of entries currently APPLIED (the undo cursor). */
let applied = 0;

/** Bind the history to a project; a REAL switch clears it. */
export function bindHistory(nextProjectId: string | null): void {
  if (nextProjectId === projectId) return;
  projectId = nextProjectId;
  entries = [];
  applied = 0;
}

/** Record a completed edit. Redo tail (undone entries) truncates, standard branching. */
export function pushHistory(entry: HistoryEntry): void {
  if (entry.changes.length === 0) return;
  entries.length = applied;
  entries.push(entry);
  if (entries.length > CAPACITY) entries.shift();
  applied = entries.length;
}

/** The entry ⌘Z would revert, without moving the cursor. */
export function peekUndo(): HistoryEntry | null {
  return applied > 0 ? entries[applied - 1] : null;
}

export function peekRedo(): HistoryEntry | null {
  return applied < entries.length ? entries[applied] : null;
}

/** Move the cursor back and hand the entry to the executor (App owns the writers). */
export function takeUndo(): HistoryEntry | null {
  if (applied === 0) return null;
  applied -= 1;
  return entries[applied];
}

export function takeRedo(): HistoryEntry | null {
  if (applied >= entries.length) return null;
  const entry = entries[applied];
  applied += 1;
  return entry;
}

/** A replay FAILED; put the cursor back so the stack stays truthful. */
export function restoreCursorAfterFailedUndo(): void {
  if (applied < entries.length) applied += 1;
}

export function restoreCursorAfterFailedRedo(): void {
  if (applied > 0) applied -= 1;
}
