import { viewBasis } from "./cameraProject";
import type { CameraPose } from "./cameraTrack";

/** Where the camera's four frustum corner rays (roll and aim included) meet the plane at depth `z`, as world [x, y], in the order (-x,-y), (-x,+y), (+x,-y), (+x,+y); null for a corner that never reaches the plane. Pure sizing maths shared by the rig overscan and the depth helpers. */
export function frustumOnPlane(
  pose: Pick<CameraPose, "position" | "lookAt" | "fov" | "rollDeg">,
  aspect: number,
  z: number,
): ([number, number] | null)[] {
  const basis = viewBasis(pose);
  const tanV = Math.tan((pose.fov * Math.PI) / 360);
  const [px, py, pz] = pose.position;
  const hits: ([number, number] | null)[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const d: [number, number, number] = [
        -basis.z[0] + sx * tanV * aspect * basis.x[0] + sy * tanV * basis.y[0],
        -basis.z[1] + sx * tanV * aspect * basis.x[1] + sy * tanV * basis.y[1],
        -basis.z[2] + sx * tanV * aspect * basis.x[2] + sy * tanV * basis.y[2],
      ];
      if (Math.abs(d[2]) < 1e-6) {
        hits.push(null);
        continue;
      }
      const along = (z - pz) / d[2];
      hits.push(along <= 0 ? null : [px + d[0] * along, py + d[1] * along]);
    }
  }
  return hits;
}

/** The world rectangle a camera sees on one plane: the bounding box of the frustum hits. */
export interface PlaneFrame {
  width: number;
  height: number;
  center: [number, number, number];
}

/** The bounding rectangle of `frustumOnPlane`'s hits at `z`; null when any corner misses the plane (the camera sees past it). */
export function frameOnPlane(
  pose: Pick<CameraPose, "position" | "lookAt" | "fov" | "rollDeg">,
  aspect: number,
  z: number,
): PlaneFrame | null {
  const hits = frustumOnPlane(pose, aspect, z);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const hit of hits) {
    if (!hit) return null;
    minX = Math.min(minX, hit[0]);
    maxX = Math.max(maxX, hit[0]);
    minY = Math.min(minY, hit[1]);
    maxY = Math.max(maxY, hit[1]);
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
    center: [(minX + maxX) / 2, (minY + maxY) / 2, z],
  };
}
