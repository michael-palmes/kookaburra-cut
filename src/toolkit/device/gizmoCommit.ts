import type { DeviceEditCommit } from "../../engine/deviceEditStore";
import type { SceneDocDeviceLayoutDelta } from "../../engine/sceneDocSchema";
import type { V3 } from "../types";

/** Turns a finished device gizmo drag into exactly what the Position drill's sliders would write, so a laid-out scene keeps editing its `deviceLayout` delta and a block-less one keeps editing raw placement. One rule for both branches: `committed = authored + (dragged - rendered)`, positions and rotations adding, scale multiplying. Differencing against the RENDERED pose (what the gizmo started from) is what survives everything the render does on top: DevicesFallback's portrait scale factor, templates' frozen multipliers, the layout resolver's own composition and the ground clamp. */

export interface DevicePose {
  position: V3;
  rotationDeg: V3;
  scale: number;
}

export interface DeviceCommitInput {
  deviceId: string;
  sceneIndex: number;
  /** Read off the gizmo proxy at pointer-up. */
  dragged: DevicePose;
  /** The pose the proxy started from: the committed placement as rendered. */
  rendered: DevicePose;
  /** `devices[i].placement` from the doc: what the sliders themselves read and write. */
  authored: { position?: V3; rotationDeg?: V3; scale?: number };
  /** This device's current `deviceLayout` delta; present only while a block is live, which is the branch the sliders take. */
  delta?: SceneDocDeviceLayoutDelta;
}

/** What `Device` renders a placement with no position at, so a first drag lands where it was dropped (the drill's own -0.3 fallback would teleport it). */
const DEFAULT_POSITION: V3 = [0, 0, 0];
const ZERO: V3 = [0, 0, 0];
const MIN_SCALE = 0.01;

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

const moved = (old: V3, dragged: V3, rendered: V3, dp: number): V3 => [
  round(old[0] + (dragged[0] - rendered[0]), dp),
  round(old[1] + (dragged[1] - rendered[1]), dp),
  round(old[2] + (dragged[2] - rendered[2]), dp),
];

const resized = (old: number, dragged: number, rendered: number): number => {
  const factor = Math.abs(rendered) <= 1e-6 ? 1 : dragged / rendered;
  return round(Math.max(MIN_SCALE, old * factor), 3);
};

export function deviceGizmoCommit(input: DeviceCommitInput): DeviceEditCommit {
  const { deviceId, sceneIndex, dragged, rendered, authored, delta } = input;
  if (delta) {
    return {
      sceneIndex,
      deviceId,
      kind: "delta",
      delta: {
        offset: moved(delta.offset ?? ZERO, dragged.position, rendered.position, 3),
        rotationDeg: moved(delta.rotationDeg ?? ZERO, dragged.rotationDeg, rendered.rotationDeg, 1),
        scale: resized(delta.scale ?? 1, dragged.scale, rendered.scale),
      },
    };
  }
  return {
    sceneIndex,
    deviceId,
    kind: "placement",
    placement: {
      position: moved(
        authored.position ?? DEFAULT_POSITION,
        dragged.position,
        rendered.position,
        3,
      ),
      rotationDeg: moved(
        authored.rotationDeg ?? ZERO,
        dragged.rotationDeg,
        rendered.rotationDeg,
        1,
      ),
      scale: resized(authored.scale ?? 1, dragged.scale, rendered.scale),
    },
  };
}
