import type { DeviceMediaSpec } from "../toolkit/device/Device";

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

/** Whether a device screen spec carries any source-timing key (`inMs`, `outMs`, `speed`, `loop`, `posterMs`); without one the screen keeps the legacy `clipFrameIndex` call. */
export function hasPlaybackKeys(m: DeviceMediaSpec): boolean {
  return (
    m.inMs !== undefined ||
    m.outMs !== undefined ||
    m.speed !== undefined ||
    m.loop !== undefined ||
    m.posterMs !== undefined
  );
}

/**
 * A device screen's frame: `startMs` (plus `offsetMs`, a foldable's opening moment) is the scene-time delay, and `inMs`/`outMs`/`speed`/`loop`/`posterMs` map that playback onto source frames. Before playback it shows the poster, else the first played frame; past `outMs` or the clip's end it holds the last played frame unless `loop` wraps within `[inMs, outMs)`. Speed floors, so frames repeat or skip and never blend.
 *
 * @param offsetMs added to the spec's own `startMs` (0 unless the screen starts when a fold opens)
 * @param n        number of extracted frames
 */
export function deviceClipFrameIndex(
  localMs: number,
  offsetMs: number,
  m: DeviceMediaSpec,
  fps: number,
  n: number,
): number {
  // Byte-frozen: even reordering this sum against `localMs` changes 1.9% of legacy frame choices.
  if (!hasPlaybackKeys(m)) return clipFrameIndex(localMs, offsetMs + (m.startMs ?? 0), fps, n);
  if (n <= 0) return 0;
  const startMs = offsetMs + (m.startMs ?? 0);
  const inF = Math.min(n - 1, sourceFrame(m.inMs ?? 0, fps, Math.floor));
  const outF = m.outMs === undefined ? n : Math.min(n, sourceFrame(m.outMs, fps, Math.ceil));
  const len = Math.max(1, outF - inF);
  // A TSX spec skips the sidecar parser, so an out-of-range speed plays at 1×.
  const speed = m.speed !== undefined && m.speed > 0 && m.speed <= 16 ? m.speed : 1;
  const raw = Math.floor(((localMs - startMs) / 1000) * fps * speed);
  if (raw < 0) {
    if (m.posterMs === undefined) return inF;
    return Math.min(n - 1, sourceFrame(m.posterMs, fps, Math.floor));
  }
  return inF + (m.loop ? raw % len : Math.min(raw, len - 1));
}

/** Source ms to a frame index; multiplying first keeps whole-frame times exact (`(2050 / 1000) * 60` floors to 122). */
function sourceFrame(ms: number, fps: number, round: (x: number) => number): number {
  const frame = round((ms * fps) / 1000);
  return frame > 0 ? frame : 0;
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
