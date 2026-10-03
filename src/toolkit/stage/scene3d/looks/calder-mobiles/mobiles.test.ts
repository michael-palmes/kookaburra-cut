import { Euler, Matrix4, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  BASE_DEPTH,
  backFloor,
  buildMobiles,
  createMobileFrame,
  MAX_JOINTS,
  MAX_MOBILES,
  MAX_PADDLES,
  type MobileParams,
  mobileWires,
  type PaddleShape,
  paddleOutline,
  poseMobiles,
  THREAD_RISE,
} from "./mobiles";

const DEFAULTS: MobileParams = { count: 6, paddle: 1, clearance: 0.45, depth: 34, seed: 1 };
const PERIOD = 120;

/** World y of every outline vertex of every paddle in a posed frame. */
function lowestPaddleY(
  rig: ReturnType<typeof buildMobiles>,
  frame: ReturnType<typeof createMobileFrame>,
) {
  const m = new Matrix4();
  const v = new Vector3();
  const lowest = rig.mobiles.map(() => Number.POSITIVE_INFINITY);
  rig.paddles.forEach((e, i) => {
    const o = i * 5;
    const p = e.paddle;
    m.makeRotationFromEuler(new Euler(frame.paddles[o + 4], frame.paddles[o + 3], -p.droop, "YXZ"));
    for (const [x, y] of paddleOutline(p.shape)) {
      v.set(x * p.size, y * p.size, 0).applyMatrix4(m);
      lowest[e.mobile] = Math.min(lowest[e.mobile], frame.paddles[o + 1] + v.y);
    }
  });
  return lowest;
}

describe("paddleOutline", () => {
  it("gives open-ended simple outlines reaching along +x from the attachment", () => {
    for (const shape of [0, 1, 2] as PaddleShape[]) {
      const pts = paddleOutline(shape);
      expect(pts.length).toBeGreaterThan(20);
      const xs = pts.map(([x]) => x);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.max(...xs)).toBeLessThanOrEqual(1 + 1e-9);
      for (let i = 1; i < pts.length; i++) {
        expect(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])).toBeGreaterThan(0);
      }
      const [first, last] = [pts[0], pts.at(-1) as [number, number]];
      expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeGreaterThan(0);
    }
  });
});

describe("buildMobiles", () => {
  const rig = buildMobiles(DEFAULTS);

  it("is deterministic and keeps the requested count", () => {
    expect(buildMobiles(DEFAULTS)).toEqual(rig);
    expect(rig.mobiles).toHaveLength(6);
    expect(buildMobiles({ ...DEFAULTS, count: 1 }).mobiles).toHaveLength(3);
    expect(buildMobiles({ ...DEFAULTS, count: 99 }).mobiles).toHaveLength(MAX_MOBILES);
  });

  it("keeps each arrangement stable whatever the count", () => {
    const seven = buildMobiles({ ...DEFAULTS, count: 7 });
    expect(seven.mobiles.slice(0, 6)).toEqual(rig.mobiles);
    expect(buildMobiles({ ...DEFAULTS, seed: 2 }).mobiles).not.toEqual(rig.mobiles);
  });

  it("balances every arm: reach is inverse to the weight each side", () => {
    for (const mb of rig.mobiles) {
      let below = (mb.arms.at(-1)?.right?.size ?? 0) ** 2;
      for (let k = mb.arms.length - 1; k >= 0; k--) {
        const a = mb.arms[k];
        const wl = a.left.size ** 2;
        expect(a.dl * wl).toBeCloseTo(a.dr * below, 9);
        below += wl + 0.05 * (a.dl + a.dr);
      }
    }
  });

  it("hangs the back mobiles by the clearance and scales them with depth", () => {
    const back = rig.mobiles.slice(0, 3);
    expect(back[0].floor).toBeCloseTo(backFloor(1, -38, 0.45 + 0.1), 9);
    for (const mb of back) expect(Math.hypot(mb.anchor[0], mb.anchor[2])).toBeGreaterThan(33);
    const deep = buildMobiles({ ...DEFAULTS, depth: 45 }).mobiles[0];
    expect(deep.anchor[2]).toBeCloseTo((-38 * 45) / BASE_DEPTH, 9);
    expect(buildMobiles({ ...DEFAULTS, clearance: 0.6 }).mobiles[0].floor).toBeGreaterThan(
      back[0].floor,
    );
  });

  it("fits the joint and paddle capacity at the most mobiles", () => {
    const most = buildMobiles({ ...DEFAULTS, count: MAX_MOBILES });
    expect(most.jointCount).toBe(MAX_JOINTS);
    expect(most.paddles).toHaveLength(MAX_PADDLES);
  });
});

describe("poseMobiles", () => {
  const rig = buildMobiles({ ...DEFAULTS, count: MAX_MOBILES });

  it("loops exactly and moves visibly within a few seconds", () => {
    const a = createMobileFrame();
    const b = createMobileFrame();
    poseMobiles(rig, 17.5, PERIOD, 1, a);
    poseMobiles(rig, 17.5 + PERIOD, PERIOD, 1, b);
    for (let i = 0; i < a.joints.length; i++) expect(b.joints[i]).toBeCloseTo(a.joints[i], 3);
    poseMobiles(rig, 21.5, PERIOD, 1, b);
    let moved = 0;
    for (let i = 0; i < rig.jointCount; i++) {
      const d = Math.hypot(
        a.joints[i * 3] - b.joints[i * 3],
        a.joints[i * 3 + 2] - b.joints[i * 3 + 2],
      );
      moved = Math.max(moved, d);
    }
    expect(moved).toBeGreaterThan(0.5);
  });

  it("holds still at zero swing", () => {
    const a = createMobileFrame();
    const b = createMobileFrame();
    poseMobiles(rig, 3, PERIOD, 0, a);
    poseMobiles(rig, 50, PERIOD, 0, b);
    expect(Array.from(b.joints)).toEqual(Array.from(a.joints));
    expect(Array.from(b.paddles)).toEqual(Array.from(a.paddles));
  });

  it("links each arm to the one below and hangs the thread above the top pivot", () => {
    const f = createMobileFrame();
    poseMobiles(rig, 40, PERIOD, 1, f);
    const j = (i: number) => [f.joints[i * 3], f.joints[i * 3 + 1], f.joints[i * 3 + 2]];
    const near = (a: number[], b: number[]) => {
      for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 4);
    };
    for (const mb of rig.mobiles) {
      near(j(mb.joint), [mb.anchor[0], mb.anchor[1] + THREAD_RISE, mb.anchor[2]]);
      near(j(mb.joint + 1), mb.anchor);
      mb.arms.slice(0, -1).forEach((a, k) => {
        const endR = j(mb.joint + 3 + 3 * k);
        const next = j(mb.joint + 4 + 3 * k);
        expect(next[0]).toBeCloseTo(endR[0], 5);
        expect(next[1]).toBeCloseTo(endR[1] - a.drop, 5);
        expect(next[2]).toBeCloseTo(endR[2], 5);
      });
    }
  });

  it("never lets a paddle swing below its mobile's floor", () => {
    const f = createMobileFrame();
    const swing = 60 / 35;
    for (let t = 0; t < PERIOD; t += 2.5) {
      poseMobiles(rig, t, PERIOD, swing, f);
      lowestPaddleY(rig, f).forEach((y, m) => {
        expect(y).toBeGreaterThanOrEqual(rig.mobiles[m].floor - 1e-6);
      });
    }
  });

  it("keeps the default back mobiles above an atlas camera's headline sightline", () => {
    const def = buildMobiles(DEFAULTS);
    const eye = new Vector3(0, 0.97, 6.93);
    const elevation = (mb: (typeof def.mobiles)[number]) =>
      Math.atan2(mb.floor - eye.y, Math.hypot(mb.anchor[0] - eye.x, mb.anchor[2] - eye.z));
    const landscape = Math.atan2(2 - eye.y, eye.z);
    const portrait = Math.atan2(2.15 - eye.y, eye.z);
    for (const mb of def.mobiles.slice(0, 3)) expect(elevation(mb)).toBeGreaterThan(landscape);
    expect(elevation(def.mobiles[0])).toBeGreaterThan(portrait);
  });
});

describe("mobileWires", () => {
  const wires = mobileWires();

  it("indexes only real joints, mobile-major", () => {
    for (const w of wires) for (const j of w.joints) expect(j).toBeLessThan(MAX_JOINTS);
    const order = wires.map((w) => w.mobile);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(MAX_MOBILES);
  });

  it("gives every mobile one thread, one strand per arm and a drop between arms", () => {
    const rig = buildMobiles({ ...DEFAULTS, count: MAX_MOBILES });
    rig.mobiles.forEach((mb, m) => {
      const mine = wires.filter((w) => w.mobile === m);
      expect(mine.filter((w) => w.kind === 1)).toHaveLength(1);
      expect(mine).toHaveLength(1 + mb.arms.length + (mb.arms.length - 1));
      expect(mine[0].joints).toEqual([mb.joint + 1, mb.joint]);
    });
  });
});
