import type { Placement } from "../theme/tokens";

/** Orbit <-> view converters shared by the camera track and the light rig (lifted from sceneCamera.ts when lights gained orbit placement). Azimuth 0 / elevation 0 sits on the target's +Z axis; the pair is lossless, so orbit sliders, XYZ fields and gizmos can edit the same entity without a mode trap. Pure math, no three.js. */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export interface OrbitPose {
  target: [number, number, number];
  azimuthDeg: number;
  elevationDeg: number;
  distance: number;
}

/** Orbit -> view: position on the sphere around `target`, looking at `target`. */
export function orbitToView(pose: OrbitPose): {
  position: [number, number, number];
  lookAt: [number, number, number];
} {
  const az = pose.azimuthDeg * DEG2RAD;
  const el = pose.elevationDeg * DEG2RAD;
  const cosEl = Math.cos(el);
  return {
    position: [
      pose.target[0] + pose.distance * cosEl * Math.sin(az),
      pose.target[1] + pose.distance * Math.sin(el),
      pose.target[2] + pose.distance * cosEl * Math.cos(az),
    ],
    lookAt: [pose.target[0], pose.target[1], pose.target[2]],
  };
}

/** View -> orbit (the move tools' inverse). Degenerate zero-distance -> angles 0. */
export function orbitFromView(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): OrbitPose {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return {
    target: [target[0], target[1], target[2]],
    azimuthDeg: distance === 0 ? 0 : Math.atan2(dx, dz) * RAD2DEG,
    elevationDeg: distance === 0 ? 0 : Math.asin(dy / distance) * RAD2DEG,
    distance,
  };
}

/** A light/fixture placement resolved to a position in its own space: orbit placements orbit the entity's aim point (its own `distance`, never the legacy LIGHT_RADIUS); point placements are literal. */
export function placementPosition(
  placement: Placement,
  aim: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  if (placement.mode === "point") return placement.position;
  return orbitToView({
    target: aim,
    azimuthDeg: placement.azimuthDeg,
    elevationDeg: placement.elevationDeg,
    distance: placement.distance,
  }).position;
}

/** The stored-mode conversions for the placement editors (lossless both ways). */
export function placementToOrbit(
  placement: Placement,
  aim: [number, number, number] = [0, 0, 0],
): Extract<Placement, { mode: "orbit" }> {
  if (placement.mode === "orbit") return placement;
  const orbit = orbitFromView(placement.position, aim);
  return {
    mode: "orbit",
    azimuthDeg: orbit.azimuthDeg,
    elevationDeg: orbit.elevationDeg,
    distance: orbit.distance,
  };
}

export function placementToPoint(
  placement: Placement,
  aim: [number, number, number] = [0, 0, 0],
): Extract<Placement, { mode: "point" }> {
  if (placement.mode === "point") return placement;
  return { mode: "point", position: placementPosition(placement, aim) };
}
