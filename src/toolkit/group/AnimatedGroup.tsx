import { type ReactNode, useContext, useEffect } from "react";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useTextMotionRegistry } from "../../engine/textMotionRegistry";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import {
  hasOwnAnimationProps,
  sampleTextUnit,
  type TextAnimTiming,
  type TextDirection,
  type TextPresetName,
} from "../text/presets";
import type { EaseName, V3 } from "../types";
import { GroupAnimationContext, type GroupAnimationState } from "./context";
import {
  DEFAULT_GROUP_EM,
  DEFAULT_GROUP_EXTENT,
  groupShineBand,
  resolveGroupAnimation,
} from "./groupAnimation";

export interface AnimatedGroupProps {
  /** In-animation start, in ms (local scene time). */
  from?: number;
  /** In-animation end, in ms. */
  to?: number;
  /** Out start, in ms; the out plays over the same duration as the in. */
  outAt?: number;
  /** In-animation preset. Defaults to the theme's `textAnimation.in`. */
  preset?: TextPresetName;
  /** Out-animation preset; plays only when `outAt` is set. */
  outPreset?: TextPresetName;
  /** Easing for preset animations. Defaults to the theme's `motion.easings.standard`. */
  ease?: EaseName;
  /** fade-scale: starting scale, landing at 1. */
  startScale?: number;
  /** fade-scale: sweep the soft white shine band once across the whole lockup. */
  shine?: boolean;
  /** twist-scale: the side the card turns in from. */
  direction?: TextDirection;
  position?: V3;
  /** World units per em for offset presets (default 0.6). */
  em?: number;
  /** Group extent [width, height] the shine band sweeps, group-local units. */
  extent?: readonly [number, number];
  children?: ReactNode;
}

/** Animates its children as one unit through the shared text-preset sampler, the group mechanism for icon+text lockups: granularity is forced null (`scatter-scale` on a group is the whole-lockup degenerate), child presets compose (alphas multiply through `GroupAnimationContext`, transforms nest), and the pivot is deliberately the group's origin since measured-bounds pivots depend on load timing, a determinism smell. */
export function AnimatedGroup(props: AnimatedGroupProps) {
  const { from = 0, to = 600, outAt, position = [0, 0, 0], children } = props;
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const parent = useContext(GroupAnimationContext);
  const sceneIndex = useSceneContext()?.index;
  const { localMs } = useTimeline();

  // Report coded motion to the registry, same rule as the headline.
  const coded = hasOwnAnimationProps(props);
  useEffect(() => {
    if (!coded || sceneIndex === undefined) return;
    useTextMotionRegistry.getState().register(sceneIndex);
    return () => useTextMotionRegistry.getState().unregister(sceneIndex);
  }, [coded, sceneIndex]);

  const anim = resolveGroupAnimation(props, theme, doc);
  const hasOut = anim !== null && anim.outPreset !== "none" && outAt !== undefined;
  if (anim === null || (anim.preset === "none" && !hasOut)) {
    // Plain positioned group; a parent group's context (if any) passes straight through.
    return <group position={position}>{children}</group>;
  }

  const em = props.em ?? DEFAULT_GROUP_EM;
  const timing: TextAnimTiming = { anim, from, to, outAt };
  const sample = sampleTextUnit(timing, 0, localMs);

  // Shine is a fade-scale scale-in feature (the headline rule); capability is mount-stable since the resolved animation cannot change without a scene remount.
  const shineCapable = anim.params.shine && anim.preset === "fade-scale";
  const band = shineCapable
    ? groupShineBand(props.extent ?? DEFAULT_GROUP_EXTENT, sample.shineU)
    : null;
  // Nested groups compose: alphas multiply (× 1 is fp-exact when there is no parent); the inner provider shadows the outer band for its own subtree.
  const state: GroupAnimationState = {
    alpha: sample.alpha * (parent?.alpha ?? 1),
    band,
    shineCapable,
  };

  return (
    <group
      position={[
        position[0] + sample.dxEm * em,
        position[1] + sample.dyEm * em,
        position[2] + sample.dzEm * em,
      ]}
      rotation={[0, sample.rotYRad, sample.rotZRad]}
      scale={sample.scale}
    >
      <GroupAnimationContext.Provider value={state}>{children}</GroupAnimationContext.Provider>
    </group>
  );
}
