/** How deep planar mirrors nest: a floor drawn in another floor's mirror makes none of its own and keeps its last, since unbounded, N floors in one render cost N! renders. */
export const MIRROR_DEPTH_CAP = 1;

export function createMirrorNest(cap = MIRROR_DEPTH_CAP): {
  readonly depth: number;
  full(): boolean;
  within<T>(render: () => T): T;
} {
  let depth = 0;
  return {
    get depth() {
      return depth;
    },
    full: () => depth >= cap,
    within(render) {
      depth += 1;
      try {
        return render();
      } finally {
        depth -= 1;
      }
    },
  };
}
