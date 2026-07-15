import type { Theme } from "../../theme/tokens";
import {
  type ResolvedTextAnimation,
  type ResolveTextAnimationProps,
  resolveTextAnimationWithDoc,
  shineBand,
  type TextAnimationDocFields,
} from "../text/presets";
import type { GroupShineBand } from "./context";

/** Pure group-animation logic, kept out of the component so it unit-tests without touching the React/three module graph (the fixedMath/stageOptions pattern). */

/** Default world units per em for the offset presets (matches the headline default size). */
export const DEFAULT_GROUP_EM = 0.6;
/** Default group extent ([width, height], group-local units) the shine band sweeps. */
export const DEFAULT_GROUP_EXTENT: readonly [number, number] = [4, 2.25];

/** The group's animation: the shared resolver with granularity forced null since the group is one unit (`scatter-scale` on a group is the whole-lockup degenerate), so theme/sidecar stagger and delivery spellings never split it; honours the sidecar's `textAnimationForce` exactly like the headline. Returns null when nothing is configured anywhere (a plain positioned group). */
export function resolveGroupAnimation(
  props: ResolveTextAnimationProps,
  theme: Theme,
  doc?: TextAnimationDocFields | null,
): ResolvedTextAnimation | null {
  const resolved = resolveTextAnimationWithDoc(props, theme, doc);
  return resolved === null ? null : { ...resolved, granularity: null };
}

/** The group-space shine band: the shine-band math over the group's extent rect, centred on the group origin; null while the band is off/parked (`shineU` < 0). */
export function groupShineBand(
  extent: readonly [number, number],
  shineU: number,
): GroupShineBand | null {
  const [w, h] = extent;
  return shineBand([-w / 2, -h / 2, w / 2, h / 2], shineU);
}
