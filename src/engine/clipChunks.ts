/** Clip cache chunks: an extracted clip fills in fixed 120-frame chunks (src-tauri/src/clip_cache.rs), so a consumer's frame set maps to the chunks it must have on disk before it binds. Pure; see docs/determinism.md "Embedded video". */

/** Frames per chunk; mirrors `CHUNK_FRAMES` in clip_cache.rs. */
export const CHUNK_FRAMES = 120;

/** How far outside its own window a scene still advances clip frames; mirrors useClipTexture's near gate. */
export const CLIP_ACTIVE_LEAD_MS = 500;

/** Past this many 1 ms samples a window takes every chunk instead (a superset is always safe). */
const MAX_WINDOW_SAMPLES = 1_200_000;

export function chunkOf(frame: number): number {
  return Math.floor(frame / CHUNK_FRAMES);
}

export function chunkCount(frameCount: number): number {
  return Math.ceil(Math.max(0, frameCount) / CHUNK_FRAMES);
}

/** Every chunk of a clip. */
export function allChunks(frameCount: number): number[] {
  return Array.from({ length: chunkCount(frameCount) }, (_, c) => c);
}

/** The chunks holding `frames`, clamped to the clip. */
export function chunksForFrames(frames: Iterable<number>, frameCount: number): Set<number> {
  const out = new Set<number>();
  if (frameCount <= 0) return out;
  for (const frame of frames) {
    out.add(chunkOf(Math.min(frameCount - 1, Math.max(0, Math.floor(frame)))));
  }
  return out;
}

/**
 * Every chunk a frame mapping touches over scene time `[fromMs, toMs]`, added to `into`. Sampling every 1 ms is exact for any mapping whose frames each last longer than 1 ms, which every clip mapping does (60 fps at up to 16x speed holds a frame 1.04 ms); the window's own ends are sampled too. A window too long to sample takes the whole clip.
 */
export function windowChunks(
  frameAt: (localMs: number) => number,
  fromMs: number,
  toMs: number,
  frameCount: number,
  into: Set<number>,
): void {
  const total = chunkCount(frameCount);
  if (total === 0) return;
  if (!(toMs >= fromMs) || toMs - fromMs > MAX_WINDOW_SAMPLES) {
    for (let c = 0; c < total; c++) into.add(c);
    return;
  }
  const seen = new Set<number>();
  const steps = Math.floor(toMs - fromMs);
  for (let k = 0; k <= steps + 1 && seen.size < total; k++) {
    const ms = k > steps ? toMs : fromMs + k;
    const frame = Math.min(frameCount - 1, Math.max(0, frameAt(ms)));
    seen.add(chunkOf(frame));
  }
  for (const c of seen) into.add(c);
}
