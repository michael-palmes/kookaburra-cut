import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Sphere, Vector3 } from "three";

/** Dish floors: a floor that stays flat round the stage and rises in a convex curve past `start`, so far floor patterns face a level camera instead of collapsing into the horizon. Convexity is the safety rule: no chord between two points above the surface dips under it, so a camera inside the dish never sees the stage hidden by it, and a camera outside it sees only the dish's back faces on the near side, which cull (F11 for free). */

/** A dish profile in world units: flat to `start`, then `rise` higher every `span` further out, squared. */
export interface DishShape {
  start: number;
  span: number;
  rise: number;
}

/** Height above the flat floor at radius `r` (mirrors GLSL `dishHeight`). */
export function dishHeight(r: number, dish: DishShape): number {
  const q = Math.max(0, (r - dish.start) / dish.span);
  return dish.rise * q * q;
}

/** Radial slope at `r` (mirrors GLSL `dishSlope`). */
export function dishSlope(r: number, dish: DishShape): number {
  const q = Math.max(0, (r - dish.start) / dish.span);
  return (2 * dish.rise * q) / dish.span;
}

/** VERTEX-SAFE. Paste `${LOOK_GLSL_DISH}` and pass the shape as `vec3(start, span, rise)`. `dishHeight`/`dishSlope` mirror the TS; `dishNormal(xz, dish)` is the surface normal; `dishShear(n, xz, dish)` carries a flat-floor normal onto the dish (lift each vertex by `dishHeight` of its own radius, then shear its normal); `dishEdgeOn(wp, up)` is 1 where the view grazes the surface, for softening the cutaway silhouette toward the backing. */
// language=GLSL
export const LOOK_GLSL_DISH: string = /* glsl */ `
#ifndef KK_LOOK_DISH
#define KK_LOOK_DISH
float dishHeight(float r, vec3 dish) {
  float q = max(0.0, (r - dish.x) / dish.y);
  return dish.z * q * q;
}
float dishSlope(float r, vec3 dish) {
  float q = max(0.0, (r - dish.x) / dish.y);
  return 2.0 * dish.z * q / dish.y;
}
vec3 dishShear(vec3 n, vec2 xz, vec3 dish) {
  float r = length(xz);
  vec2 radial = r > 1e-4 ? xz / r : vec2(0.0);
  vec3 m = n;
  m.xz -= dishSlope(r, dish) * radial * n.y;
  return normalize(m);
}
vec3 dishNormal(vec2 xz, vec3 dish) { return dishShear(vec3(0.0, 1.0, 0.0), xz, dish); }
float dishEdgeOn(vec3 wp, vec3 up) {
  return 1.0 - smoothstep(0.0, 0.04, dot(normalize(cameraPosition - wp), up));
}
#endif
`;

/** Floor vertex shader for `createDishDiscGeometry`: scales the unit disc to `uDiscRadius`, lifts it onto the dish at `uFloorY` and passes `vWorld`. */
// language=GLSL
export const DISH_FLOOR_VERTEX_SHADER: string = /* glsl */ `
${LOOK_GLSL_DISH}
uniform vec3 uDish;
uniform float uDiscRadius;
uniform float uFloorY;
varying vec3 vWorld;
void main() {
  vec2 p = position.xz * uDiscRadius;
  vec4 w = modelMatrix * vec4(p.x, uFloorY + dishHeight(length(p), uDish), p.y, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** A unit polar grid in xz (centre to rim), faces up, with a stage-centred bounding sphere of `bounds`: lift it in the vertex stage (`DISH_FLOOR_VERTEX_SHADER`) so the Dish slider never rebuilds it. About one ring per world unit keeps the facets within a hundredth of the curve. */
export function createDishDiscGeometry(
  rings: number,
  segments: number,
  bounds: number,
): BufferGeometry {
  const pos = new Float32Array((rings + 1) * (segments + 1) * 3);
  const idx = new Uint32Array(rings * segments * 6);
  let p = 0;
  for (let k = 0; k <= rings; k++) {
    const r = k / rings;
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      pos[p++] = r * Math.cos(th);
      pos[p++] = 0;
      pos[p++] = r * Math.sin(th);
    }
  }
  let o = 0;
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < segments; j++) {
      const a = k * (segments + 1) + j;
      const c = a + segments + 1;
      idx.set([a, a + 1, c, a + 1, c + 1, c], o);
      o += 6;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.boundingSphere = new Sphere(new Vector3(), bounds);
  return g;
}
