import { type PerspectiveCamera, Uniform } from "three";

/** Sub-pixel offsets for supersampled export: a rotated grid at four samples, Halton (2, 3) beyond. Export contract once shipped. */
const ROTATED_GRID: [number, number][] = [
  [0.125, 0.375],
  [0.375, -0.125],
  [-0.125, -0.375],
  [-0.375, 0.125],
];

function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
}

/** Sample `k` of `count`, in pixels from the pixel centre. */
export function supersampleOffset(k: number, count: number): [number, number] {
  if (count === 4) return ROTATED_GRID[k];
  return [halton(k + 1, 2) - 0.5, halton(k + 1, 3) - 0.5];
}

/** The supersample draw in flight, read by shaders that offset their screen-fixed noise so the samples average it away; 0 outside supersampling. */
export const supersampleSeed = new Uniform(0);

/** How many draws the frame in flight averages, 1 outside supersampling: the haze march thins by it, since its draws offset by the seed and together still take four full marches. */
export const supersampleCount = new Uniform(1);

let sharing = true;
let frames = 0;
let frame = 0;

/** The memory probe's lever: off, every supersample draw marches and mirrors in full, as before. */
export function setSupersampleSharing(on: boolean): void {
  sharing = on;
}

/** Work the jitter cannot change, done once a supersampled frame: `reuse` is true when the caller already made it for the frame in flight, in an earlier draw or an earlier pass of this one; `reset` forgets it. */
export function createFrameShare(): { reuse(): boolean; reset(): void } {
  let made = 0;
  return {
    reuse() {
      if (frame !== 0 && frame === made) return true;
      made = frame;
      return false;
    },
    reset() {
      made = 0;
    },
  };
}

/** A draw that renders one scene in two states (a compare frame) shares nothing: called before its renders. */
export function unshareSupersampleDraw(): void {
  frame = 0;
}

/** Jitters the camera to sample `k` of `count` and marks it as the draw in flight. */
export function beginSupersample(
  cam: PerspectiveCamera,
  width: number,
  height: number,
  k: number,
  count: number,
): void {
  const [dx, dy] = supersampleOffset(k, count);
  supersampleSeed.value = k;
  if (sharing) {
    if (k === 0) frames += 1;
    frame = frames;
    supersampleCount.value = count;
  }
  cam.setViewOffset(width, height, dx, dy, width, height);
}

export function endSupersample(cam: PerspectiveCamera): void {
  supersampleSeed.value = 0;
  frame = 0;
  supersampleCount.value = 1;
  cam.clearViewOffset();
}
