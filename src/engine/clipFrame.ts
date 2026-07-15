/**
 * Maps scene-local time to a pre-extracted source frame index, the deterministic core of `VideoClip`; pure function of the timeline value (no wall clock) so preview and export pick the identical frame, clamped to hold the first/last frame outside the clip's range. See docs/determinism.md.
 *
 * @param localMs    scene-local time in ms (from `useTimeline().localMs`)
 * @param startMs    when the clip starts within the scene, in ms
 * @param fps        the clip's constant extraction rate (frames were resampled to this)
 * @param frameCount number of extracted frames
 */
export function clipFrameIndex(
  localMs: number,
  startMs: number,
  fps: number,
  frameCount: number,
  /** Video background fills: wrap instead of clamping so the clip repeats for the scene's whole window; default false keeps the frozen hold behaviour above. */
  loop = false,
): number {
  if (frameCount <= 0) return 0;
  const raw = Math.floor(((localMs - startMs) / 1000) * fps);
  if (loop) return ((raw % frameCount) + frameCount) % frameCount;
  return Math.min(frameCount - 1, Math.max(0, raw));
}

/** World-space plane size for a clip inside the format's frame rectangle, honouring `fit` (`contain` letterboxes, `cover` fills and lets overflow clip via the frustum); returns `[0, 0]` until the clip geometry is known. */
export function clipPlaneSize(
  fit: "cover" | "contain",
  frame: { width: number; height: number },
  clip: { width: number; height: number },
): { width: number; height: number } {
  if (clip.width <= 0 || clip.height <= 0) return { width: 0, height: 0 };
  const clipAspect = clip.width / clip.height;
  const frameAspect = frame.width / frame.height;
  // Whether the clip is "wider" than the frame decides which dimension binds.
  const widerThanFrame = clipAspect > frameAspect;
  const bindWidth = fit === "contain" ? widerThanFrame : !widerThanFrame;
  return bindWidth
    ? { width: frame.width, height: frame.width / clipAspect }
    : { width: frame.height * clipAspect, height: frame.height };
}
