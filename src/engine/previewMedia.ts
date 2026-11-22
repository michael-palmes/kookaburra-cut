import { isExporting, subscribeExporting } from "./exportState";

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

/** True while the paused playhead is being dragged or stepped quickly: clip consumers bind the preview tier until it rests, then the exact full frame. A lone step never counts, so frame-by-frame stays exact. */
const SCRUB_GAP_MS = 120;
const SCRUB_REST_MS = 180;
let scrubActive = false;
let lastClockMoveAt = Number.NEGATIVE_INFINITY;
let scrubRest: ReturnType<typeof setTimeout> | undefined;
const scrubListeners = new Set<() => void>();

function setScrubActive(active: boolean): void {
  if (scrubActive === active) return;
  scrubActive = active;
  for (const listener of scrubListeners) listener();
}

/** Called on every preview clock change with the realm's own time. */
export function notePreviewClockMove(now: number): void {
  if (playbackActive) return;
  if (now - lastClockMoveAt < SCRUB_GAP_MS) setScrubActive(true);
  lastClockMoveAt = now;
  if (!scrubActive) return;
  clearTimeout(scrubRest);
  scrubRest = setTimeout(() => setScrubActive(false), SCRUB_REST_MS);
}

// A capture can start at the very instant a skim rested on, with no clock change to re-render a consumer: the scrub ends with it, so the exact frame binds before the capture's barrier.
subscribeExporting(() => {
  if (!isExporting()) return;
  clearTimeout(scrubRest);
  setScrubActive(false);
});

export function previewScrubActive(): boolean {
  return scrubActive;
}

export function subscribePreviewScrub(listener: () => void): () => void {
  scrubListeners.add(listener);
  return () => scrubListeners.delete(listener);
}

/** Present's clock never stops for a scrub, so its clips always read ahead; set once by the present worker at boot. */
let presentClock = false;
export function setPresentClock(on: boolean): void {
  presentClock = on;
}

/** Whether clips extract ahead of the playhead: while preview playback runs, and always in Present. */
export function clipReadAheadActive(): boolean {
  return playbackActive || presentClock;
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

/** Camera motion blur samples while preview playback runs; 0 keeps playback sharp. App owns it (the "Motion blur while playing" toggle and preview quality); paused frames always use the project's count. */
let motionBlurPlaybackSamples = 0;
export function setPreviewMotionBlurPlayback(samples: number): void {
  motionBlurPlaybackSamples = Math.max(0, Math.floor(samples));
}
export function previewMotionBlurPlaybackSamples(): number {
  return motionBlurPlaybackSamples;
}

/** Perf-probe no-motion-blur pass (same contract as env-off): the preview renders every frame plain while this is on. */
let motionBlurOff = false;
export function setPreviewMotionBlurOff(value: boolean): void {
  motionBlurOff = value;
}
export function previewMotionBlurOff(): boolean {
  return motionBlurOff;
}
