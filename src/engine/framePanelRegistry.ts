import type { Group } from "three";

/** Live handles onto each mounted overlay panel's `<group>`, published by `<FramePanel>`; mirrors `sceneHostRegistry.ts`. The panel is a sibling of the scene hosts (so it lays out against the full frame, not the cutout), and the compositor draws the active scene's panel over the composited slide. See engine/compositor.ts. */
export interface FramePanelHandle {
  index: number;
  group: Group;
  /** Comparison panels opt in only when first-class Overlay images need the one-after-composite draw. */
  hasSceneImages: boolean;
  /** A `<ScreenLayer order="front">`: drawn after the scene's own panel, in mount order. */
  screenLayer?: boolean;
  /** Runs right before the compositor draws this panel. */
  beforeDraw?: () => void;
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

/** What the compositor draws over a scene, panel first then its screen layers; null when there is nothing. */
export function framePanelsFor(
  handles: readonly FramePanelHandle[],
  index: number,
  comparing = false,
): FramePanelHandle[] | null {
  const found = handles.filter((p) => p.index === index && (!comparing || p.hasSceneImages));
  if (found.length === 0) return null;
  return [...found.filter((p) => !p.screenLayer), ...found.filter((p) => p.screenLayer)];
}
