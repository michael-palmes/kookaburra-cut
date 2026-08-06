import type { StageRect } from "../../engine/gizmoRegistry";
import { normaliseDeg } from "../../engine/sceneDocSchema";

/** The pure geometry behind the 2D gizmo layer: NDC and stage-pixel conversions, the rotated-rect frame every host draws, the corner/rotate/resize maths lifted from `DecorationGizmo`, and the alignment-guide snapping. Plain data in and out, so the one set of rules every 2D host shares stays provable in the node test environment. */

export type Pt = readonly [number, number];

/** An item's outline as it is drawn: a rotated rectangle in client pixels. */
export interface Gizmo2DFrame {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Clockwise on screen, the `FrameDecoration` convention. */
  deg: number;
  /** What rotation (and a `pivot` resize) turns about: the box centre for a decoration, the anchor for a headline. */
  pivot: Pt;
}

/** Alignment snap distance (stage pixels) for the smart guides. */
export const SNAP_PX = 6;

/** Rotation snap (degrees) while Shift is held. */
export const SNAP_DEG = 15;

export function ndcToStagePx(ndc: Pt, rect: StageRect): Pt {
  return [rect.left + ((ndc[0] + 1) / 2) * rect.width, rect.top + ((1 - ndc[1]) / 2) * rect.height];
}

export function stagePxToNdc(px: Pt, rect: StageRect): Pt | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return [(2 * (px[0] - rect.left)) / rect.width - 1, 1 - (2 * (px[1] - rect.top)) / rect.height];
}

/** Rotate a screen vector clockwise (screen y is down) by `deg`. */
export function rotatePx(vx: number, vy: number, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [vx * c - vy * s, vx * s + vy * c];
}

/** The best-fit rotated rectangle of a projected quad, corners ordered top-left, top-right, bottom-right, bottom-left in the item's own local frame. Exact whenever the projection is affine (every default framing); a mild approximation under a rolled or heavily tilted rig pose. */
export function frameFromQuad(quad: readonly [Pt, Pt, Pt, Pt], pivot: Pt): Gizmo2DFrame {
  const [tl, tr, br, bl] = quad;
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) / 4;
  const cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
  const topX = tr[0] - tl[0];
  const topY = tr[1] - tl[1];
  const botX = br[0] - bl[0];
  const botY = br[1] - bl[1];
  const w = (Math.hypot(topX, topY) + Math.hypot(botX, botY)) / 2;
  const h =
    (Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) + Math.hypot(br[0] - tr[0], br[1] - tr[1])) / 2;
  const ax = topX + botX;
  const ay = topY + botY;
  const deg = ax === 0 && ay === 0 ? 0 : (Math.atan2(ay, ax) * 180) / Math.PI;
  return { cx, cy, w, h, deg, pivot };
}

/** Half-extents of the frame's axis-aligned bounding box, accounting for its rotation. */
export function aabbHalfExtents(frame: Gizmo2DFrame): Pt {
  const r = (frame.deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const hw = frame.w / 2;
  const hh = frame.h / 2;
  return [hw * c + hh * s, hw * s + hh * c];
}

/** A corner in client pixels; `cx`/`cy` are the NDC signs of the offset from the centre (y up), the `HANDLES` convention. */
export function cornerPx(frame: Gizmo2DFrame, cx: -1 | 1, cy: -1 | 1): Pt {
  const [ox, oy] = rotatePx((cx * frame.w) / 2, (-cy * frame.h) / 2, frame.deg);
  return [frame.cx + ox, frame.cy + oy];
}

/** The shortest resize lever a pivot may offer, as a fraction of the box's own diagonal. */
const MIN_LEVER = 0.25;

/** The fixed point and diagonal a corner resize measures against. `pivot` mode keeps the item's own pivot only while it is a real lever: a headline anchored on a corner or an edge of its own block leaves the pivot on (or straight above) the dragged corner, where projecting onto that diagonal is dead or wildly oversensitive, so the opposite corner takes over. */
export function resizeBasis(
  frame: Gizmo2DFrame,
  cx: -1 | 1,
  cy: -1 | 1,
  about: "pivot" | "opposite-corner",
): { fixed: Pt; diag: Pt } {
  const dragged = cornerPx(frame, cx, cy);
  const opposite = cornerPx(frame, -cx as -1 | 1, -cy as -1 | 1);
  const full: Pt = [dragged[0] - opposite[0], dragged[1] - opposite[1]];
  if (about === "pivot") {
    const diag: Pt = [dragged[0] - frame.pivot[0], dragged[1] - frame.pivot[1]];
    if (Math.hypot(diag[0], diag[1]) >= MIN_LEVER * Math.hypot(full[0], full[1])) {
      return { fixed: frame.pivot, diag };
    }
  }
  return { fixed: opposite, diag: full };
}

/** The pointer projected onto the resize diagonal: 1 at the dragged corner, 0 at the fixed point. A degenerate diagonal holds at 1 rather than dividing by zero. */
export function resizeFactor(fixed: Pt, diag: Pt, pointer: Pt): number {
  const dd = diag[0] * diag[0] + diag[1] * diag[1];
  if (dd <= 0) return 1;
  return ((pointer[0] - fixed[0]) * diag[0] + (pointer[1] - fixed[1]) * diag[1]) / dd;
}

/** The angle from the pivot to the pointer, clockwise from straight up; `snap` rounds to 15°. */
export function rotationDegAt(pivot: Pt, pointer: Pt, snap: boolean): number {
  const vx = pointer[0] - pivot[0];
  const vy = pointer[1] - pivot[1];
  const deg = (Math.atan2(vx, -vy) * 180) / Math.PI;
  return snap ? Math.round(deg / SNAP_DEG) * SNAP_DEG : deg;
}

/** The item's new screen angle for a rotate drag: the angle it had when the drag began plus the turn the pointer has made about the pivot since the grab, folded into (-180, 180] and snapped to 15° while Shift is held. The knob sits at the box's top centre, which is straight up from the pivot only when the two coincide, so the gesture is relative and never the raw pointer angle. */
export function rotationDragDeg(
  frame: Gizmo2DFrame,
  grabDeg: number,
  pointer: Pt,
  snap: boolean,
): number {
  const turn = normaliseDeg(rotationDegAt(frame.pivot, pointer, false) - grabDeg);
  const deg = normaliseDeg(frame.deg + turn);
  return snap ? normaliseDeg(Math.round(deg / SNAP_DEG) * SNAP_DEG) : deg;
}

/** The nearest alignment line to any of the anchors, within the snap threshold, else null. */
export function nearestLine(
  anchors: readonly number[],
  lines: readonly number[],
  snapPx: number,
): { off: number; line: number } | null {
  let best: { off: number; line: number } | null = null;
  let bestAbs = snapPx;
  for (const a of anchors) {
    for (const t of lines) {
      const off = t - a;
      if (Math.abs(off) < bestAbs) {
        bestAbs = Math.abs(off);
        best = { off, line: t };
      }
    }
  }
  return best;
}

/** The move snap: the box centre and both bounding-box edges are candidate anchors on each axis, and the guides report the lines that won, in client pixels. */
export function resolveMoveSnap(
  centre: Pt,
  extents: Pt,
  xLines: readonly number[],
  yLines: readonly number[],
  snapPx: number,
): { dx: number; dy: number; guideX: number | null; guideY: number | null } {
  const sx = nearestLine(
    [centre[0], centre[0] - extents[0], centre[0] + extents[0]],
    xLines,
    snapPx,
  );
  const sy = nearestLine(
    [centre[1], centre[1] - extents[1], centre[1] + extents[1]],
    yLines,
    snapPx,
  );
  return {
    dx: sx ? sx.off : 0,
    dy: sy ? sy.off : 0,
    guideX: sx ? sx.line : null,
    guideY: sy ? sy.line : null,
  };
}

/** Frame-level snap lines in client pixels: the frame centre on both axes plus the four safe-area edges. */
export function frameGuideLines(
  rect: StageRect,
  safePx: { left: number; top: number; right: number; bottom: number },
): { x: number[]; y: number[] } {
  return {
    x: [rect.left + rect.width / 2, rect.left + safePx.left, rect.left + rect.width - safePx.right],
    y: [rect.top + rect.height / 2, rect.top + safePx.top, rect.top + rect.height - safePx.bottom],
  };
}

/** Where a ray crosses a z plane, or null when it is parallel to it or points away. */
export function rayPlaneZ(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  z: number,
): [number, number, number] | null {
  if (Math.abs(dir[2]) < 1e-9) return null;
  const t = (z - origin[2]) / dir[2];
  if (!(t > 0)) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, z];
}
