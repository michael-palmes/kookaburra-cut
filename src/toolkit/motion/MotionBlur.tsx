import type { ReactNode } from "react";
import { MotionBlurContext } from "../../engine/timeline";

/** Scales motion blur from its subtree's own motion: 0 keeps it sharp, 1 is the scene's shutter, 2 doubles the trail. Camera blur is unaffected. */
export function MotionBlur({ amount, children }: { amount: number; children: ReactNode }) {
  return (
    <MotionBlurContext.Provider value={Math.max(0, amount)}>{children}</MotionBlurContext.Provider>
  );
}
