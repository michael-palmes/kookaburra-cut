/** Corner-bracket geometry for the section-scoped selection outlines: three arms per corner for a solid box (12 corners), two per corner for a flat rectangle (`size[2]` of 0, the staged chart). Pure, so the maths is node-testable and the outline component stays a thin r3f wrapper. */

/** Arm length as a fraction of the SHORTEST half-extent, so a 0.07-deep phone never draws arms longer than it is deep. */
export const OUTLINE_ARM_FRACTION = 0.28;

export function outlineBracketSegments(
  size: readonly [number, number, number],
  fraction: number = OUTLINE_ARM_FRACTION,
): Float32Array {
  const hx = Math.abs(size[0]) / 2;
  const hy = Math.abs(size[1]) / 2;
  const hz = Math.abs(size[2]) / 2;
  const flat = hz <= 0;
  const shortest = flat ? Math.min(hx, hy) : Math.min(hx, hy, hz);
  const arm = shortest * fraction;
  const verts: number[] = [];
  const push = (a: readonly number[], b: readonly number[]) => verts.push(...a, ...b);

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      if (flat) {
        const c = [sx * hx, sy * hy, 0];
        push(c, [c[0] - sx * arm, c[1], 0]);
        push(c, [c[0], c[1] - sy * arm, 0]);
        continue;
      }
      for (const sz of [-1, 1]) {
        const c = [sx * hx, sy * hy, sz * hz];
        push(c, [c[0] - sx * arm, c[1], c[2]]);
        push(c, [c[0], c[1] - sy * arm, c[2]]);
        push(c, [c[0], c[1], c[2] - sz * arm]);
      }
    }
  }
  return new Float32Array(verts);
}
