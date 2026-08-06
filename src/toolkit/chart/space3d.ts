/** 3D chart space: the layout's 0..1 plot rect maps to `width` x `height` world units with the ground at y 0, marks centred on z 0 and the group origin at the centre of the floor, so the HOST owns placement and `style.rotation`. Pure functions of (depth, size): no clock, no three.js, no state. (The 2D renderer centres its plot on the origin instead; a 3D chart stands on a floor.) */

export interface Chart3DSpace {
  width: number;
  height: number;
  /** Extrusion depth in world units, resolved from `style.depth`. */
  depth: number;
  halfDepth: number;
  /** min(width, height): what type sizes, radii and pads scale from. */
  unit: number;
  /** z the gridlines sit at, behind every mark. */
  wallZ: number;
  /** z label furniture sits at, just clear of the front faces. */
  frontZ: number;
  /** Gap between the plot edge and its label furniture. */
  pad: number;
  /** Separation between stacked layers along the value axis, so coincident faces never z-fight (a fixed geometric offset, never `polygonOffset`). */
  stackEpsilon: number;
}

/** `style.depth` 0..1 maps to this fraction of the plot's short side. */
const DEPTH_MIN = 0.06;
const DEPTH_MAX = 0.34;
const WALL_GAP = 0.05;
const FRONT_GAP = 0.03;
const PAD = 0.055;
const STACK_EPSILON = 0.0005;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function chart3dSpace(depth: number, width: number, height: number): Chart3DSpace {
  const w = Number.isFinite(width) ? Math.max(1e-3, width) : 1;
  const h = Number.isFinite(height) ? Math.max(1e-3, height) : 1;
  const unit = Math.min(w, h);
  const extrusion = (DEPTH_MIN + clamp01(depth) * (DEPTH_MAX - DEPTH_MIN)) * unit;
  const halfDepth = extrusion / 2;
  return {
    width: w,
    height: h,
    depth: extrusion,
    halfDepth,
    unit,
    wallZ: -halfDepth - WALL_GAP * unit,
    frontZ: halfDepth + FRONT_GAP * unit,
    pad: PAD * unit,
    stackEpsilon: STACK_EPSILON * unit,
  };
}

/** Plot x (0..1, left to right) to world x, centred on the group origin. */
export const chartWorldX = (space: Chart3DSpace, u: number): number => (u - 0.5) * space.width;

/** Plot y (0..1, up) to world y, with the plot floor at 0. */
export const chartWorldY = (space: Chart3DSpace, v: number): number => v * space.height;
