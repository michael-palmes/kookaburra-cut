import type { Group } from "three";

/** Live handles onto each mounted scene's `<group>`, published by `<SceneHost>`; the compositor reads these to gate per-frame visibility for both preview and export, mirroring the single `canvasHandle` in `exportBridge.tsx` but as a keyed collection since all scenes mount at once. */
export interface SceneHostHandle {
  index: number;
  /** The manifest FILE, the unique scene identity (TSX ids may collide); write-only here, the compositor gates on index/side and never reads it. */
  id: string;
  startMs: number;
  durationMs: number;
  group: Group;
  /** Which comparison side this host renders; absent for every plain scene (and comparison side A rides the plain host). Only the compositor's visibility gating reads it. */
  side?: "b";
}

// Keyed by a per-instance id (React useId) so a project swap's unmount/mount churn can't clobber entries by index.
const hosts = new Map<string, SceneHostHandle>();
const listeners = new Set<() => void>();
let revision = 0;

function notifySceneHostsChanged(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function registerSceneHost(key: string, handle: SceneHostHandle): void {
  hosts.set(key, handle);
  notifySceneHostsChanged();
}

export function unregisterSceneHost(key: string): void {
  if (hosts.delete(key)) notifySceneHostsChanged();
}

/** Current scene hosts, ordered by timeline index (a comparison's side-B host follows its base host). */
export function getSceneHosts(): SceneHostHandle[] {
  return [...hosts.values()].sort(
    (a, b) => a.index - b.index || (a.side === "b" ? 1 : 0) - (b.side === "b" ? 1 : 0),
  );
}

export function subscribeSceneHosts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sceneHostRegistryRevision(): number {
  return revision;
}
