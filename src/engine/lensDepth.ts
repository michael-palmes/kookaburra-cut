import type { Camera } from "three";
import type { ResolvedDof } from "./dof";

/** Depth-only stand-ins (a lifted `ScreenRegion` card) live on this layer, which only the draw feeding an active lens pose's depth turns on. EXPORT CONTRACT. */
export const LENS_DEPTH_LAYER = 31;

/** Runs `draw` with the lens depth layer visible to `camera` when `dof` is an active lens pose; every other draw never sees it. */
export function withLensDepth(
  camera: Camera,
  dof: ResolvedDof | null | undefined,
  draw: () => void,
): void {
  const on =
    !!dof && dof.mode === "lens" && dof.blur > 0 && !camera.layers.isEnabled(LENS_DEPTH_LAYER);
  if (on) camera.layers.enable(LENS_DEPTH_LAYER);
  try {
    draw();
  } finally {
    if (on) camera.layers.disable(LENS_DEPTH_LAYER);
  }
}
