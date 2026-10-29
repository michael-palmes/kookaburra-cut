import type { StoreApi } from "zustand";
import type { MirroredStore } from "../engine/stageProtocol";

/** Keeps a zustand store's DATA fields equal across the realm boundary: every change on one side posts the changed fields, the other side applies them without echoing. Actions (functions) never cross; each realm keeps its own. Bidirectional by construction, so a worker-side write (a gizmo's `pendingCommit`, a canvas click's `select`) reaches the window exactly like a window write reaches the worker. */

type AnyStore = StoreApi<Record<string, unknown>>;

export interface StoreMirror {
  /** Applies a patch that arrived from the other realm. */
  apply(name: MirroredStore, patch: Record<string, unknown>): void;
  /** Every mirrored store's current data, for the first sync. */
  snapshot(): { name: MirroredStore; patch: Record<string, unknown> }[];
  stop(): void;
}

function dataFields(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== "function") out[key] = value;
  }
  return out;
}

export function mirrorStores(
  stores: Partial<Record<MirroredStore, AnyStore>>,
  send: (name: MirroredStore, patch: Record<string, unknown>) => void,
): StoreMirror {
  const applying = new Set<MirroredStore>();
  const offs: (() => void)[] = [];
  for (const [name, store] of Object.entries(stores) as [MirroredStore, AnyStore][]) {
    offs.push(
      store.subscribe((state, prev) => {
        if (applying.has(name)) return;
        const patch: Record<string, unknown> = {};
        let changed = false;
        for (const key of Object.keys(state)) {
          const value = state[key];
          if (typeof value === "function" || Object.is(value, prev[key])) continue;
          patch[key] = value;
          changed = true;
        }
        if (changed) send(name, patch);
      }),
    );
  }
  return {
    apply(name, patch) {
      const store = stores[name];
      if (!store) return;
      applying.add(name);
      try {
        store.setState(patch);
      } finally {
        applying.delete(name);
      }
    },
    snapshot() {
      return (Object.entries(stores) as [MirroredStore, AnyStore][]).map(([name, store]) => ({
        name,
        patch: dataFields(store.getState()),
      }));
    },
    stop() {
      for (const off of offs) off();
    },
  };
}
