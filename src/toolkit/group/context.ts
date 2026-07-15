import { createContext, useContext } from "react";
import { SHINE_AXIS } from "../text/presets";
import type { V3 } from "../types";

/** Group animation state for `AnimatedGroup`: alpha propagates via React context, never material traversal (a parent writing child materials would race the child's own per-frame write, a determinism smell), and the shine band is precomputed in group space then folded per child via `foldBandToChild` (accounts for a child's `position` prop only, ignoring rotation/scale). */

/** A shine band along `SHINE_AXIS`, in the space of whoever holds it. */
export interface GroupShineBand {
  centerS: number;
  invHalfWidthS: number;
}

export interface GroupAnimationState {
  /** The group's sampled alpha this frame; children multiply it into their opacity. */
  alpha: number;
  /** This frame's shine band in group space; null = off/parked. */
  band: GroupShineBand | null;
  /** MOUNT-STABLE: whether this group can ever shine; children use it once per mount to decide whether to route through a shine-capable material variant. */
  shineCapable: boolean;
}

/** null = not inside an `AnimatedGroup`, so children behave exactly as they did before groups existed. */
export const GroupAnimationContext = createContext<GroupAnimationState | null>(null);

/** The enclosing group's animation state, or null outside groups; the hook custom primitives use to participate (multiply `alpha` into your own opacity CPU-side). */
export function useGroupAnimation(): GroupAnimationState | null {
  return useContext(GroupAnimationContext);
}

/** Expresses the group-space band in a child's local space: shifts the band centre by the child's group-local offset projected on the sweep axis (widths are offset-invariant); returns null when there is no band to show. */
export function foldBandToChild(
  state: GroupAnimationState | null,
  position: V3,
): GroupShineBand | null {
  if (!state?.band) return null;
  return {
    centerS: state.band.centerS - (position[0] * SHINE_AXIS[0] + position[1] * SHINE_AXIS[1]),
    invHalfWidthS: state.band.invHalfWidthS,
  };
}
