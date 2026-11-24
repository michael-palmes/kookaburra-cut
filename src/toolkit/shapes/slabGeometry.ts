import { type BufferGeometry, ExtrudeGeometry, Shape } from "three";
import { smoothExtrudeNormals } from "../text3d/extrudeNormals";

/** A rounded plate, centred: `radius` and `edge` are in world units, the corner radius capped at half the smaller side so 0.5 of it makes a capsule, the edge rounding capped just under half the smaller side and half the depth, where the rim is a full half round. Bevelled plates get smooth normals with truly flat faces. */
export function slabGeometry(
  width: number,
  height: number,
  depth: number,
  radius: number,
  edge: number,
): BufferGeometry {
  const least = Math.min(width, height);
  const e = Math.min(Math.max(edge, 0), least * 0.45, depth * 0.5 - 1e-4);
  const halfW = width / 2 - e;
  const halfH = height / 2 - e;
  const r = Math.min(Math.max(radius - e, 0), halfW, halfH);
  const shape = new Shape();
  shape.moveTo(-halfW + r, -halfH);
  shape.lineTo(halfW - r, -halfH);
  shape.absarc(halfW - r, -halfH + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(halfW, halfH - r);
  shape.absarc(halfW - r, halfH - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-halfW + r, halfH);
  shape.absarc(-halfW + r, halfH - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-halfW, -halfH + r);
  shape.absarc(-halfW + r, -halfH + r, r, Math.PI, Math.PI * 1.5, false);
  const geometry = new ExtrudeGeometry(shape, {
    depth: Math.max(depth - 2 * e, 0.0001),
    curveSegments: 16,
    bevelEnabled: e > 0,
    bevelSize: e,
    bevelThickness: e,
    bevelSegments: 6,
  });
  geometry.center();
  if (e <= 0) return geometry;
  const smooth = smoothExtrudeNormals(geometry);
  if (smooth !== geometry) geometry.dispose();
  return smooth;
}
