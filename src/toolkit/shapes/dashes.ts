import { dashSegments } from "../chart/chart2dMath";

/** One dash: its centre, visible length and angle (radians, from +x). */
export interface DashPiece {
  x: number;
  y: number;
  length: number;
  angle: number;
}

/** Lays dashes along a polyline, one slot per dash, each segment starting and ending on a dash (`dashSegments`). Only the part of the path inside `reveal` (fractions of its length) shows, so a draw-on trims the dash it ends inside; hidden slots keep length 0 so the slot count never changes. */
export function dashPolyline(
  points: readonly (readonly [number, number])[],
  dash: number,
  gap: number,
  reveal: readonly [number, number] = [0, 1],
): DashPiece[] {
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = lengths.reduce((sum, len) => sum + len, 0);
  const lo = Math.max(0, Math.min(1, reveal[0])) * total;
  const hi = Math.max(0, Math.min(1, reveal[1])) * total;
  const out: DashPiece[] = [];
  let at = 0;
  lengths.forEach((len, i) => {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const dx = len > 0 ? (bx - ax) / len : 1;
    const dy = len > 0 ? (by - ay) / len : 0;
    const angle = Math.atan2(dy, dx);
    for (const [start, length] of dashSegments(len, dash, gap)) {
      const s = Math.max(at + start, lo);
      const e = Math.min(at + start + length, hi);
      const visible = Math.max(0, e - s);
      const mid = visible > 0 ? (s + e) / 2 - at : start + length / 2;
      out.push({ x: ax + dx * mid, y: ay + dy * mid, length: visible, angle });
    }
    at += len;
  });
  return out;
}
