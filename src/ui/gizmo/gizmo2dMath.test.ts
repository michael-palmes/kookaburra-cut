import { describe, expect, it } from "vitest";
import {
  aabbHalfExtents,
  cornerPx,
  frameFromQuad,
  frameGuideLines,
  type Gizmo2DFrame,
  ndcToStagePx,
  nearestLine,
  type Pt,
  rayPlaneZ,
  resizeBasis,
  resizeFactor,
  resolveMoveSnap,
  rotatePx,
  rotationDegAt,
  rotationDragDeg,
  stagePxToNdc,
} from "./gizmo2dMath";

const RECT = { left: 100, top: 50, width: 800, height: 400 };

/** A rotated rectangle's four corners, ordered top-left, top-right, bottom-right, bottom-left. */
function quadOf(cx: number, cy: number, w: number, h: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const corner = (dx: number, dy: number): Pt => [cx + dx * c - dy * s, cy + dx * s + dy * c];
  return [
    corner(-w / 2, -h / 2),
    corner(w / 2, -h / 2),
    corner(w / 2, h / 2),
    corner(-w / 2, h / 2),
  ] as [Pt, Pt, Pt, Pt];
}

function frame(over: Partial<Gizmo2DFrame> = {}): Gizmo2DFrame {
  return { cx: 0, cy: 0, w: 200, h: 100, deg: 0, pivot: [0, 0], ...over };
}

describe("ndcToStagePx / stagePxToNdc", () => {
  it("round trips the centre and all four corners", () => {
    for (const ndc of [
      [0, 0],
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
    ] as Pt[]) {
      const px = ndcToStagePx(ndc, RECT);
      const back = stagePxToNdc(px, RECT);
      expect(back?.[0]).toBeCloseTo(ndc[0], 10);
      expect(back?.[1]).toBeCloseTo(ndc[1], 10);
    }
    expect(ndcToStagePx([0, 0], RECT)).toEqual([500, 250]);
  });

  it("returns null for a degenerate rect rather than NaN", () => {
    expect(stagePxToNdc([10, 10], { left: 0, top: 0, width: 0, height: 400 })).toBeNull();
    expect(stagePxToNdc([10, 10], { left: 0, top: 0, width: 800, height: 0 })).toBeNull();
  });
});

describe("frameFromQuad", () => {
  it("reproduces an axis-aligned rect exactly", () => {
    const f = frameFromQuad(quadOf(300, 200, 240, 120, 0), [300, 200]);
    expect(f.cx).toBeCloseTo(300, 10);
    expect(f.cy).toBeCloseTo(200, 10);
    expect(f.w).toBeCloseTo(240, 10);
    expect(f.h).toBeCloseTo(120, 10);
    expect(f.deg).toBeCloseTo(0, 10);
  });

  it("reproduces a rotated rect's size and angle", () => {
    const f = frameFromQuad(quadOf(0, 0, 240, 120, 30), [0, 0]);
    expect(f.w).toBeCloseTo(240, 10);
    expect(f.h).toBeCloseTo(120, 10);
    expect(f.deg).toBeCloseTo(30, 10);
  });

  it("never reports a negative width for a mirrored quad", () => {
    const [tl, tr, br, bl] = quadOf(0, 0, 240, 120, 0);
    const f = frameFromQuad([tr, tl, bl, br], [0, 0]);
    expect(f.w).toBeCloseTo(240, 10);
    expect(f.h).toBeCloseTo(120, 10);
  });
});

describe("aabbHalfExtents", () => {
  it("is the half size at 0 degrees", () => {
    expect(aabbHalfExtents(frame())).toEqual([100, 50]);
  });

  it("matches hw·|cos| + hh·|sin| on a 30 degree box", () => {
    const r = (30 * Math.PI) / 180;
    const [ex, ey] = aabbHalfExtents(frame({ deg: 30 }));
    expect(ex).toBeCloseTo(100 * Math.cos(r) + 50 * Math.sin(r), 10);
    expect(ey).toBeCloseTo(100 * Math.sin(r) + 50 * Math.cos(r), 10);
  });
});

describe("cornerPx", () => {
  it("places the four corners of an upright box", () => {
    const f = frame({ cx: 500, cy: 250 });
    expect(cornerPx(f, -1, 1)).toEqual([400, 200]);
    expect(cornerPx(f, 1, 1)).toEqual([600, 200]);
    expect(cornerPx(f, 1, -1)).toEqual([600, 300]);
    expect(cornerPx(f, -1, -1)).toEqual([400, 300]);
  });
});

describe("resizeFactor", () => {
  const fixed: Pt = [0, 0];
  const diag: Pt = [100, 50];

  it("is 1 at the dragged corner and 0.5 at the diagonal midpoint", () => {
    expect(resizeFactor(fixed, diag, [100, 50])).toBeCloseTo(1, 10);
    expect(resizeFactor(fixed, diag, [50, 25])).toBeCloseTo(0.5, 10);
  });

  it("goes negative behind the fixed point and holds at 1 for a zero diagonal", () => {
    expect(resizeFactor(fixed, diag, [-100, -50])).toBeCloseTo(-1, 10);
    expect(resizeFactor(fixed, [0, 0], [40, 40])).toBe(1);
  });
});

describe("resizeBasis", () => {
  const box = frame({ cx: 500, cy: 250, pivot: [500, 250] });

  it("measures a decoration from the opposite corner, as it always has", () => {
    expect(resizeBasis(box, -1, 1, "opposite-corner")).toEqual({
      fixed: [600, 300],
      diag: [-200, -100],
    });
  });

  it("keeps a centred pivot, which is a real lever", () => {
    expect(resizeBasis(box, -1, 1, "pivot")).toEqual({ fixed: [500, 250], diag: [-100, -50] });
  });

  it("falls back when the pivot sits on the dragged corner", () => {
    const anchored = frame({ cx: 500, cy: 250, pivot: [400, 200] });
    expect(resizeBasis(anchored, -1, 1, "pivot")).toEqual({
      fixed: [600, 300],
      diag: [-200, -100],
    });
  });

  it("falls back when the pivot is straight above the dragged corner", () => {
    const anchored = frame({ cx: 500, cy: 250, w: 420, h: 60, pivot: [290, 250] });
    expect(resizeBasis(anchored, -1, 1, "pivot")).toEqual({
      fixed: [710, 280],
      diag: [-420, -60],
    });
  });

  it("keeps a corner pivot for the corner it can still drive", () => {
    const anchored = frame({ cx: 500, cy: 250, pivot: [400, 200] });
    expect(resizeBasis(anchored, 1, -1, "pivot")).toEqual({ fixed: [400, 200], diag: [200, 100] });
  });
});

describe("rotationDragDeg", () => {
  /** Where the knob is drawn: the box's top centre, 22px clear of the edge. */
  const knob = (f: Gizmo2DFrame): Pt => [f.cx, f.cy - f.h / 2 - 22];
  const grab = (f: Gizmo2DFrame) => rotationDegAt(f.pivot, knob(f), false);
  /** The knob after the box has turned `deg` about its pivot. */
  const turned = (f: Gizmo2DFrame, deg: number): Pt => {
    const k = knob(f);
    const [dx, dy] = rotatePx(k[0] - f.pivot[0], k[1] - f.pivot[1], deg);
    return [f.pivot[0] + dx, f.pivot[1] + dy];
  };

  it("does not move the item when the knob is only grabbed", () => {
    for (const pivot of [
      [500, 250],
      [400, 200],
      [400, 250],
    ] as Pt[]) {
      const f = frame({ cx: 500, cy: 250, deg: 12, pivot });
      expect(rotationDragDeg(f, grab(f), knob(f), false)).toBeCloseTo(12, 10);
    }
  });

  it("turns the item by the angle the pointer turns about the pivot", () => {
    const f = frame({ cx: 500, cy: 250, pivot: [400, 200] });
    expect(rotationDragDeg(f, grab(f), turned(f, 45), false)).toBeCloseTo(45, 10);
    expect(rotationDragDeg(f, grab(f), turned(f, -30), false)).toBeCloseTo(-30, 10);
  });

  it("stays continuous across the wrap point", () => {
    const f = frame({ cx: 500, cy: 250, deg: 170, pivot: [500, 250] });
    expect(rotationDragDeg(f, grab(f), turned(f, 20), false)).toBeCloseTo(-170, 10);
  });

  it("snaps the item's own angle to 15 degrees while Shift is held", () => {
    const f = frame({ cx: 500, cy: 250, pivot: [400, 200] });
    expect(rotationDragDeg(f, grab(f), turned(f, 22), true)).toBe(15);
  });
});

describe("rotationDegAt", () => {
  it("reads clockwise from straight up", () => {
    expect(rotationDegAt([0, 0], [0, -10], false)).toBeCloseTo(0, 10);
    expect(rotationDegAt([0, 0], [10, 0], false)).toBeCloseTo(90, 10);
    expect(rotationDegAt([0, 0], [0, 10], false)).toBeCloseTo(180, 10);
    expect(rotationDegAt([0, 0], [-10, 0], false)).toBeCloseTo(-90, 10);
  });

  it("snaps to the nearest 15 degrees", () => {
    const raw = rotationDegAt([0, 0], [10, -9], false);
    expect(raw).toBeGreaterThan(45);
    expect(rotationDegAt([0, 0], [10, -9], true)).toBe(Math.round(raw / 15) * 15);
  });
});

describe("nearestLine", () => {
  it("picks the nearest line within the threshold and nothing beyond it", () => {
    expect(nearestLine([100], [104, 97], 6)).toEqual({ off: -3, line: 97 });
    expect(nearestLine([100], [110], 6)).toBeNull();
  });

  it("lets the first anchor win a tie", () => {
    expect(nearestLine([100, 104], [102], 6)).toEqual({ off: 2, line: 102 });
  });
});

describe("resolveMoveSnap", () => {
  const xLines = [500];
  const yLines = [250];

  it("snaps a centre inside the threshold and reports the guide", () => {
    const snap = resolveMoveSnap([497, 250], [100, 50], xLines, yLines, 6);
    expect(snap.dx).toBe(3);
    expect(snap.guideX).toBe(500);
    expect(snap.dy).toBe(0);
  });

  it("snaps by an edge, not the centre, when the edge is the near anchor", () => {
    const snap = resolveMoveSnap([604, 250], [100, 50], [500], yLines, 6);
    expect(snap.dx).toBe(-4);
    expect(snap.guideX).toBe(500);
  });

  it("returns zero offsets and no guides when nothing is in range", () => {
    expect(resolveMoveSnap([0, 0], [10, 10], xLines, yLines, 6)).toEqual({
      dx: 0,
      dy: 0,
      guideX: null,
      guideY: null,
    });
  });
});

describe("frameGuideLines", () => {
  it("is the two centre lines plus the four safe edges, in pixels", () => {
    const lines = frameGuideLines(RECT, { left: 40, top: 20, right: 40, bottom: 20 });
    expect(lines.x).toEqual([500, 140, 860]);
    expect(lines.y).toEqual([250, 70, 430]);
  });
});

describe("rayPlaneZ", () => {
  it("hits the expected point on the plane", () => {
    expect(rayPlaneZ([0, 0, 5], [1, 2, -5], 0)).toEqual([1, 2, 0]);
  });

  it("is null for a parallel ray and for one pointing away", () => {
    expect(rayPlaneZ([0, 0, 5], [1, 0, 0], 0)).toBeNull();
    expect(rayPlaneZ([0, 0, 5], [0, 0, 1], 0)).toBeNull();
  });
});
