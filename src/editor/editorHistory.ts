import type { EditDoc } from "../engine/edit";

export interface EditorHistoryEntry {
  label: string;
  before: EditDoc;
  after: EditDoc;
  coalesceKey?: string;
}

const CAPACITY = 50;

let scope: string | null = null;
let entries: EditorHistoryEntry[] = [];
let applied = 0;
let openCoalesceKey: string | null = null;

const cloneEntry = (entry: EditorHistoryEntry): EditorHistoryEntry => ({
  ...entry,
  before: structuredClone(entry.before),
  after: structuredClone(entry.after),
});

/** Bind the session history to one project edit. A real edit switch clears it. */
export function bindEditorHistory(slug: string | null, name: string | null): void {
  const next = slug && name ? `${slug}\u0000${name}` : null;
  if (next === scope) return;
  scope = next;
  entries = [];
  applied = 0;
  openCoalesceKey = null;
}

/** Record one completed edit snapshot. An open continuous control may replace its latest after-state. */
export function pushEditorHistory(entry: EditorHistoryEntry): void {
  if (JSON.stringify(entry.before) === JSON.stringify(entry.after)) return;
  entries.length = applied;
  const previous = entries[entries.length - 1];
  if (
    entry.coalesceKey &&
    openCoalesceKey === entry.coalesceKey &&
    previous?.coalesceKey === entry.coalesceKey
  ) {
    previous.after = structuredClone(entry.after);
    previous.label = entry.label;
    applied = entries.length;
    return;
  }
  entries.push(cloneEntry(entry));
  if (entries.length > CAPACITY) entries.shift();
  applied = entries.length;
  openCoalesceKey = entry.coalesceKey ?? null;
}

/** Finish a continuous control gesture so a later gesture starts a fresh entry. */
export function closeEditorHistoryCoalescing(): void {
  openCoalesceKey = null;
}

export function takeEditorUndo(): EditorHistoryEntry | null {
  closeEditorHistoryCoalescing();
  if (applied === 0) return null;
  applied -= 1;
  return cloneEntry(entries[applied]);
}

export function takeEditorRedo(): EditorHistoryEntry | null {
  closeEditorHistoryCoalescing();
  if (applied >= entries.length) return null;
  const entry = cloneEntry(entries[applied]);
  applied += 1;
  return entry;
}
