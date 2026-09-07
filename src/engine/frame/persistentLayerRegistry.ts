import type { Group } from "three";

/** Live handles onto each mounted persistent (hoisted) layer's `<group>`, published by `<PersistentLayer>`; mirrors `sceneHostRegistry.ts`. The compositor reads these to keep persistent objects out of the A/B transition targets (they'd ghost, rendered into both and faded twice) and draw them exactly once per frame. See docs/determinism.md. */

// Keyed by a per-instance id (React useId) so project-swap unmount/mount churn can't clobber entries; same rationale as the scene-host registry.
const layers = new Map<string, Group>();

export function registerPersistentLayer(key: string, group: Group): void {
  layers.set(key, group);
}

export function unregisterPersistentLayer(key: string): void {
  layers.delete(key);
}

/** Current persistent layer groups. Empty for every project that declares no persistent module. */
export function getPersistentLayers(): Group[] {
  return [...layers.values()];
}
