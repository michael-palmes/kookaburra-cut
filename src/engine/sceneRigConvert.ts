/** Converting a scene between the two camera modes, and keeping object aims baked. Pure, so the round trip is testable: a conversion that visibly nudges the shot is a bug, not a nuance. */

import type { DeviceFloorY } from "../toolkit/device/worldAnchor";
import type { FormatInfo } from "../toolkit/types";
import { orbitFromView, orbitToView } from "./orbit";
import type { CameraDoc, RigDoc } from "./sceneCameraEdit";
import type { SceneDoc, SceneDocRigKey } from "./sceneDocSchema";
import { resolveAimTarget } from "./sceneRig";

/** Orbit -> free: every key becomes a position with a point aim at the old target, so the applied pose is identical. Segments carry over untouched, but every one is pinned STRAIGHT: orbit paths never curved, and the rig's default is smooth, so silently curving them would move the shot. */
export function orbitToRig(camera: CameraDoc): RigDoc {
  return {
    ...camera,
    keys: camera.keys.map((key) => {
      const view = orbitToView(key.pose);
      return {
        id: key.id,
        tMs: key.tMs,
        pose: { position: view.position, aim: { mode: "point" as const, at: view.lookAt } },
      };
    }),
    segments: camera.segments.map((seg) => ({ ...seg, smooth: false })),
  };
}

/** Can this rig go back to orbit? Only if every key aims at a POINT the orbit pose can hold as its target; a tangent aim has no target to orbit. */
export function canRigConvertToOrbit(rig: RigDoc): boolean {
  return rig.keys.length > 0 && rig.keys.every((key) => key.pose.aim.mode !== "tangent");
}

/** Free -> orbit: the aim point becomes the orbit target. Only legal when `canRigConvertToOrbit`; fov and roll have no orbit home and are dropped, which is why the UI offers this as a deliberate action rather than doing it silently. */
export function rigToOrbit(rig: RigDoc): CameraDoc | null {
  if (!canRigConvertToOrbit(rig)) return null;
  return {
    ...rig,
    keys: rig.keys.map((key) => ({
      id: key.id,
      tMs: key.tMs,
      pose: orbitFromView(key.pose.position, key.pose.aim.at),
    })),
    segments: rig.segments.map((seg) => ({ from: seg.from, to: seg.to, ease: seg.ease })),
  };
}

/** Re-resolve every object-bound key's baked `at` against the doc's current placements. The ENGINE only ever reads bindings; this is the editor's side of that contract, called in the same write as the placement edit so one undo restores both. */
export function rebakeRigBindings(
  rig: RigDoc,
  doc: SceneDoc,
  format?: FormatInfo,
  floorY?: DeviceFloorY,
): RigDoc {
  let changed = false;
  const keys: SceneDocRigKey[] = rig.keys.map((key) => {
    if (key.pose.aim.mode !== "object") return key;
    const at = resolveAimTarget(key.pose.aim.id, doc, format, floorY);
    if (!at || sameAt(at, key.pose.aim.at)) return key;
    changed = true;
    return { ...key, pose: { ...key.pose, aim: { ...key.pose.aim, at } } };
  });
  return changed ? { ...rig, keys } : rig;
}

/** Bake every key bound to `id` down to a plain point at its last known place, for when the object it followed is deleted. The shot survives; the inspector shows the broken link. */
export function bakeRigBinding(rig: RigDoc, id: string): RigDoc {
  let changed = false;
  const keys: SceneDocRigKey[] = rig.keys.map((key) => {
    if (key.pose.aim.mode !== "object" || key.pose.aim.id !== id) return key;
    changed = true;
    return {
      ...key,
      pose: { ...key.pose, aim: { mode: "point", at: [...key.pose.aim.at] } },
    };
  });
  return changed ? { ...rig, keys } : rig;
}

/** Ids this rig binds to that the doc can no longer resolve (the broken-link rows). */
export function brokenRigBindings(rig: RigDoc, doc: SceneDoc | undefined): string[] {
  const broken = new Set<string>();
  for (const key of rig.keys) {
    if (key.pose.aim.mode !== "object") continue;
    if (!doc || resolveAimTarget(key.pose.aim.id, doc) === null) broken.add(key.pose.aim.id);
  }
  return [...broken];
}

const sameAt = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
