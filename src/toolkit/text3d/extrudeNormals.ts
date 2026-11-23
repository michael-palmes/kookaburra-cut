import { type BufferGeometry, Float32BufferAttribute, Vector3 } from "three";

/** Smooth normals for a bevelled extrusion: each vertex takes its neighbouring faces' normals weighted by their corner angles (so a strip of quads shades evenly however it is cut into triangles), faces past `creaseAngle` stay apart, and vertices on the front and back planes take the plane's normal, so the bevel runs into a truly flat face. */
export function smoothExtrudeNormals(
  flat: BufferGeometry,
  creaseAngle = Math.PI / 4,
): BufferGeometry {
  const geometry = flat.index ? flat.toNonIndexed() : flat;
  const positions = geometry.getAttribute("position");
  const count = positions.count - (positions.count % 3);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || count < 3) return geometry;
  const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-9);
  const grid = 1e5 / span;
  const faces = new Float32Array(count);
  const angles = new Float32Array(count);
  const groups = new Map<string, number[]>();
  const corners = [new Vector3(), new Vector3(), new Vector3()];
  const u = new Vector3();
  const v = new Vector3();
  const n = new Vector3();
  for (let t = 0; t < count; t += 3) {
    for (let k = 0; k < 3; k++) corners[k].fromBufferAttribute(positions, t + k);
    n.crossVectors(u.subVectors(corners[1], corners[0]), v.subVectors(corners[2], corners[0]));
    const area = n.length();
    if (area > 0) n.divideScalar(area);
    faces.set([n.x, n.y, n.z], t);
    for (let k = 0; k < 3; k++) {
      const p = corners[k];
      u.subVectors(corners[(k + 1) % 3], p);
      v.subVectors(corners[(k + 2) % 3], p);
      const lengths = u.length() * v.length();
      angles[t + k] =
        area > 0 && lengths > 0 ? Math.acos(Math.min(1, Math.max(-1, u.dot(v) / lengths))) : 0;
      const key = `${Math.round(p.x * grid)},${Math.round(p.y * grid)},${Math.round(p.z * grid)}`;
      const group = groups.get(key);
      if (group) group.push(t + k);
      else groups.set(key, [t + k]);
    }
  }
  const eps = (box.max.z - box.min.z) * 1e-5;
  const least = Math.cos(creaseAngle);
  const normals = new Float32Array(positions.count * 3);
  for (const group of groups.values()) {
    for (const i of group) {
      const own = i - (i % 3);
      const z = positions.getZ(i);
      if (box.max.z - z <= eps) n.set(0, 0, 1);
      else if (z - box.min.z <= eps) n.set(0, 0, -1);
      else {
        n.set(0, 0, 0);
        for (const j of group) {
          const other = j - (j % 3);
          const along =
            faces[own] * faces[other] +
            faces[own + 1] * faces[other + 1] +
            faces[own + 2] * faces[other + 2];
          if (along < least) continue;
          n.x += faces[other] * angles[j];
          n.y += faces[other + 1] * angles[j];
          n.z += faces[other + 2] * angles[j];
        }
        if (n.lengthSq() > 0) n.normalize();
        else n.set(faces[own], faces[own + 1], faces[own + 2]);
      }
      normals.set([n.x, n.y, n.z], i * 3);
    }
  }
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  return geometry;
}
