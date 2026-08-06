/** Preview-only clip-decode knobs, owned by App (chrome state never read from a store by the engine); `useClipTexture` additionally ignores both while `isExporting()`. */

let stride = 1;

/** Balanced/Performance bind every `stride`th screen-media frame; pinned back to 1 whenever an export could run. */
export function setPreviewClipStride(value: number): void {
  stride = Math.max(1, Math.round(value));
}

export function previewClipStride(): number {
  return stride;
}

/** True while preview playback runs: clip consumers bind the small preview JPEGs instead of the full PNGs. Paused, scrubbing and exporting always bind exact full frames. */
let playbackActive = false;
const playbackListeners = new Set<() => void>();

export function setPreviewPlaybackActive(active: boolean): void {
  if (playbackActive === active) return;
  playbackActive = active;
  for (const listener of playbackListeners) listener();
}

export function previewPlaybackActive(): boolean {
  return playbackActive;
}

/** useSyncExternalStore shape, so paused consumers rebind their exact full frame immediately. */
export function subscribePreviewPlayback(listener: () => void): () => void {
  playbackListeners.add(listener);
  return () => playbackListeners.delete(listener);
}

/** Perf-probe env-off pass (preview-only, the perfClipsFrozen pattern): the compositor nulls the scene environment after the state plan applies while this is on. Never set outside the probe; the compositor additionally ignores it while `isExporting()`. */
let environmentOff = false;
export function setPreviewEnvironmentOff(value: boolean): void {
  environmentOff = value;
}
export function previewEnvironmentOff(): boolean {
  return environmentOff;
}

/** Perf-probe no-dof pass (same contract as env-off): the compositor drops the frame's dof union while this is on, so the dof/tilt passes leave the chain entirely. Never set outside the probe; ignored while `isExporting()`. */
let dofOff = false;
export function setPreviewDofOff(value: boolean): void {
  dofOff = value;
}
export function previewDofOff(): boolean {
  return dofOff;
}
