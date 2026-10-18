import type { ReactNode } from "react";
import { useTimeline } from "../../engine/timeline";
import type { V3 } from "../types";
import { ramp } from "./math";
import { type StampScaleOptions, stampScale } from "./stamp";

const DEG2RAD = Math.PI / 180;

export interface StampProps extends StampScaleOptions {
  /** Scene-local ms the stamp starts; hidden (at `from` scale) before it. */
  at: number;
  /** Optional settle: starts this many degrees off (about Z) and swings back to 0 with a small overshoot over the stamp. */
  rotateDeg?: number;
  position?: V3;
  /** Radians; the settle adds to Z. */
  rotation?: V3;
  /** Base scale the stamp multiplies. */
  scale?: number;
  children?: ReactNode;
}

/** Stamps its children in at `at`: the `stampScale` pop (its defaults are contract) about the group origin, with an optional small rotation settle. */
export function Stamp({
  at,
  rotateDeg = 0,
  position,
  rotation = [0, 0, 0],
  scale = 1,
  children,
  ...pop
}: StampProps) {
  const { localMs } = useTimeline();
  const ms = localMs - at;
  const s = stampScale(pop)(ms) * scale;
  const span = (pop.inMs ?? 180) + (pop.settleMs ?? 260);
  const settle = rotateDeg === 0 ? 0 : rotateDeg * DEG2RAD * (1 - ramp(ms, 0, span, "outBack"));
  return (
    <group
      position={position}
      rotation={[rotation[0], rotation[1], rotation[2] + settle]}
      scale={s}
      visible={s !== 0}
    >
      {children}
    </group>
  );
}
