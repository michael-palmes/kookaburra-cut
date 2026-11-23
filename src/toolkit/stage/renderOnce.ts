import type { Camera, WebGLRenderer } from "three";

type Counted = Pick<WebGLRenderer, "info">;

/** Work one render asks for twice: three draws an opaque mesh in its glass (transmission) pass and again in its main pass, calling `onBeforeRender` each time. `fresh` is true while no render has run since `made` for the same camera, so the second ask is the same render's and reuses the first's work; a nested render in between (another mirror) makes it stale. */
export function createRenderOnce(): {
  fresh(gl: Counted, camera: Camera): boolean;
  made(gl: Counted, camera: Camera): void;
  reset(): void;
} {
  let at = -1;
  let by: Camera | null = null;
  return {
    fresh: (gl, camera) => gl.info.render.frame === at && camera === by,
    made(gl, camera) {
      at = gl.info.render.frame;
      by = camera;
    },
    reset() {
      at = -1;
      by = null;
    },
  };
}
