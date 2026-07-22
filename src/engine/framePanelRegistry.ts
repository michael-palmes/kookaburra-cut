import type { Group } from "three";

/** Live handles onto each mounted overlay panel's `<group>`, published by `<FramePanel>`; mirrors `sceneHostRegistry.ts`. The panel is a sibling of the scene hosts (so it lays out against the full frame, not the cutout), and the compositor draws the active scene's panel over the composited slide. See engine/compositor.ts. */
export interface FramePanelHandle {
  index: number;
  group: Group;
}

// Keyed by a per-instance id (React useId) so a project swap's unmount/mount churn can't clobber entries by index.
const panels = new Map<string, FramePanelHandle>();

export function registerFramePanel(key: string, handle: FramePanelHandle): void {
  panels.set(key, handle);
}

export function unregisterFramePanel(key: string): void {
  panels.delete(key);
}

/** Current overlay panels. Empty for every project with no framed scene, so the compositor's panel pass is a hard no-op there. */
export function getFramePanels(): FramePanelHandle[] {
  return [...panels.values()];
}
