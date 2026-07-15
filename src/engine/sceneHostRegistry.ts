import type { Group } from "three";

/** Live handles onto each mounted scene's `<group>`, published by `<SceneHost>`; the compositor reads these to gate per-frame visibility for both preview and export, mirroring the single `canvasHandle` in `exportBridge.tsx` but as a keyed collection since all scenes mount at once. */
export interface SceneHostHandle {
  index: number;
  id: string;
  startMs: number;
  durationMs: number;
  group: Group;
}

// Keyed by a per-instance id (React useId) so a project swap's unmount/mount churn can't clobber entries by index.
const hosts = new Map<string, SceneHostHandle>();

export function registerSceneHost(key: string, handle: SceneHostHandle): void {
  hosts.set(key, handle);
}

export function unregisterSceneHost(key: string): void {
  hosts.delete(key);
}

/** Current scene hosts, ordered by timeline index. */
export function getSceneHosts(): SceneHostHandle[] {
  return [...hosts.values()].sort((a, b) => a.index - b.index);
}
