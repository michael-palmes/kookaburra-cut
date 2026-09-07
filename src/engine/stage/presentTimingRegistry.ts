/** Present-mode timing registry: staged primitives report their intro/outro windows per scene so a present window can derive hold points (src/present/holdPoint.ts). Registration is unconditional and costs one Set entry; nothing reads the registry outside a present session, so the editor and export realms carry it as dead weight by design. */

export interface PresentTimingEntry {
  kind: "text" | "group" | "device-motion";
  /** Scene-local ms when this element's intro settles. */
  toMs: number;
  /** Scene-local ms when an authored outro starts, if any. */
  outAtMs?: number;
  /** Extra settle time from staggered delivery (the last unit's start offset). */
  staggerSpreadMs?: number;
}

const entries = new Map<number, Set<PresentTimingEntry>>();
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

/** The current entries for a scene (a fresh array each call). */
export function snapshotPresentTimings(sceneIndex: number): PresentTimingEntry[] {
  return [...(entries.get(sceneIndex) ?? [])];
}

/** Subscribe to registry changes (the present driver re-derives holds on change). */
export function subscribePresentTimings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
