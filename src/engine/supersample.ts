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
