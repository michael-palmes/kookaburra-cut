import { describe, expect, it } from "vitest";
import {
  lilyPadGeometry,
  lilyPadPose,
  PAD_POOL,
  placeLilyPads,
  RAFT_GAP,
  RAFT_LOOP,
  RAFT_PERIODS,
  RIPPLE_LOOP,
  RIPPLE_PERIODS,
} from "./rafts";

describe("placeLilyPads", () => {
  const { rafts, pads } = placeLilyPads(7);

  it("fills the pool once, deterministically", () => {
    expect(pads).toHaveLength(PAD_POOL);
    expect(placeLilyPads(7)).toEqual({ rafts, pads });
  });

  it("keeps pads in one raft at most touching", () => {
    for (let i = 0; i < pads.length; i++) {
      for (let j = i + 1; j < pads.length; j++) {
        const a = pads[i];
        const b = pads[j];
        if (a.raft !== b.raft) continue;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(a.radius + b.radius);
      }
    }
  });

  it("keeps every raft's sweep clear of the others and of the clearing", () => {
    for (let i = 0; i < rafts.length; i++) {
      const a = rafts[i];
      expect(Math.hypot(a.x, a.z) - a.reach).toBeGreaterThanOrEqual(7);
      for (let j = i + 1; j < rafts.length; j++) {
        const b = rafts[j];
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(
          a.reach + b.reach + RAFT_GAP,
        );
      }
    }
    for (const p of pads) {
      const r = rafts[p.raft];
      expect(Math.hypot(p.x - r.x, p.z - r.z) + p.radius + p.eddy).toBeLessThanOrEqual(
        r.reach + 1e-9,
      );
    }
  });

  it("orders each raft core first, rafts in placement order", () => {
    let raft = 0;
    let prev = 0;
    for (const p of pads) {
      if (p.raft !== raft) {
        expect(p.raft).toBe(raft + 1);
        raft = p.raft;
        prev = 0;
      }
      const d = Math.hypot(p.x - rafts[raft].x, p.z - rafts[raft].z);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it("moves the clearing with the slider", () => {
    for (const clear of [4, 14]) {
      const out = placeLilyPads(clear);
      expect(out.pads).toHaveLength(PAD_POOL);
      for (const r of out.rafts)
        expect(Math.hypot(r.x, r.z) - r.reach).toBeGreaterThanOrEqual(clear);
    }
  });
});

describe("lilyPadPose", () => {
  const { pads } = placeLilyPads(7);

  it("loops exactly at RAFT_LOOP", () => {
    for (const period of RAFT_PERIODS) expect(RAFT_LOOP % period).toBe(0);
    for (const p of pads.slice(0, 20)) {
      const a = lilyPadPose(p, 0);
      const b = lilyPadPose(p, RAFT_LOOP);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.z).toBeCloseTo(a.z, 9);
      expect(b.yaw).toBeCloseTo(a.yaw, 9);
    }
  });

  it("moves a raft rigidly", () => {
    const [a, b] = pads.filter((p) => p.raft === 3);
    for (const t of [0, 7.3, 51]) {
      const pa = lilyPadPose(a, t);
      const pb = lilyPadPose(b, t);
      expect(Math.hypot(pa.x - pb.x, pa.z - pb.z)).toBeCloseTo(Math.hypot(a.x - b.x, a.z - b.z), 9);
    }
  });
});

describe("lilyPadGeometry", () => {
  it("packs one instance per pad around a stage-centred sphere", () => {
    const { pads } = placeLilyPads(7);
    const g = lilyPadGeometry(pads);
    expect(g.instanceCount).toBe(pads.length);
    expect(g.getAttribute("aPad").count).toBe(pads.length);
    expect(g.boundingSphere?.center.length()).toBe(0);
    g.dispose();
  });
});

describe("ripple schedule", () => {
  it("loops exactly", () => {
    for (const p of RIPPLE_PERIODS) expect(Number.isInteger(RIPPLE_LOOP / p)).toBe(true);
  });
});
