/** Present timing registry: staged primitives report their intro/outro windows per scene so a present window (src/present) and the stills exporter can derive hold points (engine/presentHoldPoint.ts). Registration is unconditional, costs one Set entry and never changes rendering; nothing else reads it, so the editor and video export carry it as dead weight by design. */

export interface PresentTimingEntry {
  kind: "text" | "group" | "device-motion" | "decoration" | "counter";
  /** Scene-local ms when this element's intro settles. */
  toMs: number;
  /** Scene-local ms when an authored outro starts, if any. */
  outAtMs?: number;
  /** Extra settle time from staggered delivery (the last unit's start offset). */
  staggerSpreadMs?: number;
}

const entries = new Map<number, Set<PresentTimingEntry>>();
const pending = new Map<number, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Registers an entry for a scene; returns the unregister function (call on unmount or timing change). */
export function registerPresentTiming(sceneIndex: number, entry: PresentTimingEntry): () => void {
  let set = entries.get(sceneIndex);
  if (!set) {
    set = new Set();
    entries.set(sceneIndex, set);
  }
  set.add(entry);
  notify();
  return () => {
    set.delete(entry);
    notify();
  };
}

/** Marks a timing the scene cannot report yet (e.g. a stagger spread awaiting its first typeset); returns the idempotent clear, called in the same commit that registers the real entry. */
export function reportPresentTimingPending(sceneIndex: number): () => void {
  pending.set(sceneIndex, (pending.get(sceneIndex) ?? 0) + 1);
  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    const left = (pending.get(sceneIndex) ?? 1) - 1;
    if (left > 0) pending.set(sceneIndex, left);
    else pending.delete(sceneIndex);
  };
}

/** Outstanding pending reports: one scene's, or every scene's when no index is given. */
export function presentTimingsPendingCount(sceneIndex?: number): number {
  if (sceneIndex !== undefined) return pending.get(sceneIndex) ?? 0;
  let total = 0;
  for (const count of pending.values()) total += count;
  return total;
}

/** The current entries for a scene (a fresh array each call). */
export function snapshotPresentTimings(sceneIndex: number): PresentTimingEntry[] {
  return [...(entries.get(sceneIndex) ?? [])];
}

/** Subscribe to registry changes (the present driver re-derives holds on change). */
export function subscribePresentTimings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
