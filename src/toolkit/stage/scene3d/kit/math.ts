/** CPU mirror of GLSL `smoothstep`, for poses and uniforms that must agree with the shaders. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** CPU mirror of GLSL `fract`: always in [0, 1), negatives included. */
export function fract(x: number): number {
  return x - Math.floor(x);
}
