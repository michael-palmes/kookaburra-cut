import type { ReactNode } from "react";
import { SteppedTimeContext } from "../../engine/timeline";

/** Steps its subtree's time at a whole `fps` (default 12, the hand-made look), counted from the scene's first frame: every pose holds for whole frames while the camera, and anything outside, moves every frame. 60 or more runs every frame. */
export function SteppedTime({ fps = 12, children }: { fps?: number; children: ReactNode }) {
  return <SteppedTimeContext.Provider value={fps}>{children}</SteppedTimeContext.Provider>;
}
