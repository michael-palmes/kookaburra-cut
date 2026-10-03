import { Vector4 } from "three";
import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import {
  BLOOMS,
  bloomAnchors,
  bloomDrop,
  bloomOpen,
  bloomPortrait,
  bloomStride,
  flutterPhase,
  turnsPerCycle,
  writeBloomPoses,
} from "./blooms";
import { look, presets } from "./index";

const azimuthDeg = (x: number, z: number) => ((Math.atan2(x, z) * 180) / Math.PI + 360) % 360;
const offAxisDeg = (x: number, z: number) =>
  (Math.asin(Math.abs(x) / Math.hypot(x, z)) * 180) / Math.PI;
const motion = [80, 4.8, 3.4] as const;
const poses = () => Array.from({ length: BLOOMS.max }, () => new Vector4());
const gap = (a: Vector4, b: Vector4) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w);
const { min, max } = look.params.count;

describe("shylight bloom layout", () => {
  it("steps phases with a stride coprime to the count, so every bloom gets its own phase", () => {
    for (let n = min; n <= max; n++) {
      const phases = bloomAnchors(n, 12).map((a) => Math.round(a.phase * n * 1000));
      expect(new Set(phases).size, `count ${n}`).toBe(n);
      expect(bloomStride(n), `count ${n}`).toBeGreaterThan(1);
    }
  });

  it("hangs the outer ring and a smaller flank tier, none over the back of the stage axis", () => {
    const anchors = bloomAnchors(18, 12);
    const radii = anchors.map((a) => Math.hypot(a.x, a.z));
    expect(radii.filter((r) => r > 10)).toHaveLength(11);
    expect(radii.filter((r) => r > 7.9 && r < 8.9)).toHaveLength(7);
    for (const a of anchors) expect(Math.abs(azimuthDeg(a.x, a.z) - 180)).toBeGreaterThan(14);
  });

  it("deals flank blooms into the quadrants beside the content at every count, so a front camera sees them either side", () => {
    for (let n = min; n <= max; n++) {
      const flank = bloomAnchors(n, 12).filter((a) => Math.hypot(a.x, a.z) < 9.5);
      const [from, to] = BLOOMS.flankArcDeg;
      for (const a of flank) {
        expect(offAxisDeg(a.x, a.z), `count ${n}`).toBeGreaterThan(from - 1.6);
        expect(offAxisDeg(a.x, a.z), `count ${n}`).toBeLessThan(to + 1.6);
      }
      const back = flank.filter((a) => a.z < 0);
      expect(back.filter((a) => a.x < 0).length, `count ${n}`).toBeGreaterThanOrEqual(1);
      expect(back.filter((a) => a.x > 0).length, `count ${n}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("opens outer blooms near the stage axis above the headline and every other bloom low, none between", () => {
    for (let n = min; n <= max; n++) {
      for (const a of bloomAnchors(n, 12)) {
        expect(a.high, `count ${n}`).toBe(
          Math.hypot(a.x, a.z) > 10 && offAxisDeg(a.x, a.z) < BLOOMS.axisConeDeg,
        );
        if (a.high) expect(a.lift, `count ${n}`).toBeGreaterThan(0.96);
        else expect(a.lift, `count ${n}`).toBeLessThan(BLOOMS.midHeight * 1.04);
      }
    }
  });

  it("keeps every ring slot clear of the high and low boundary", () => {
    for (let slots = 4; slots <= 14; slots++) {
      for (let k = 0; k < 2 * slots; k++) {
        const off = Math.abs((((k * 180) / slots + 90) % 180) - 90);
        expect(Math.abs(off - BLOOMS.axisConeDeg), `${slots} slots`).toBeGreaterThan(1.5);
      }
    }
  });

  it("keeps each bloom's jitter when the count changes", () => {
    expect(bloomAnchors(18, 12)[0].sway).toBe(bloomAnchors(20, 12)[0].sway);
  });
});

describe("shylight bloom motion", () => {
  it("drops, opens round its core, then closes before it rises", () => {
    expect([bloomDrop(0), bloomOpen(0)]).toEqual([0, 0]);
    expect(bloomOpen(0.3)).toBeCloseTo(1, 5);
    expect(bloomDrop(0.3)).toBeCloseTo(1, 5);
    expect(bloomOpen(0.58)).toBe(0);
    expect(bloomDrop(0.58)).toBeGreaterThan(0.3);
    expect([bloomDrop(0.8), bloomOpen(0.8)]).toEqual([0, 0]);
  });

  it("is at least half open whenever it hangs near its lowest point, so a bud never dips below the open rim", () => {
    for (let u = 0; u < 1; u += 0.001) {
      if (bloomDrop(u) > 0.9) expect(bloomOpen(u), `u ${u}`).toBeGreaterThan(0.5);
    }
  });

  it("keeps about a third of the blooms open, with one or more open beside the content at every count", () => {
    for (let n = min; n <= max; n++) {
      const anchors = bloomAnchors(n, 12);
      const out = poses();
      for (let t = 0; t < 80; t += 0.5) {
        writeBloomPoses(out, anchors, t, ...motion);
        const open = out.filter((p, j) => j < n && p.w > 0.5);
        expect(open.length / n, `count ${n} t ${t}`).toBeGreaterThan(0.25);
        expect(open.length / n, `count ${n} t ${t}`).toBeLessThan(0.5);
        const flank = open.filter(
          (p) => !anchors[out.indexOf(p)].high && p.z < 0 && Math.abs(p.x) > 4,
        );
        expect(flank.length, `count ${n} t ${t}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("parks high blooms above the frame and low ones a short drop over their open height", () => {
    const anchors = bloomAnchors(18, 12);
    const out = poses();
    const atPhase = (j: number, u: number) => 80 * (1 - anchors[j].phase + u);
    for (const j of [anchors.findIndex((a) => a.high), anchors.findIndex((a) => !a.high)]) {
      const low = anchors[j].lift * 4.8;
      writeBloomPoses(out, anchors, atPhase(j, 0.8), ...motion);
      const park = anchors[j].high ? 4.8 + 3.4 : low + 3.4 * BLOOMS.lowDrop;
      expect(out[j].y, `bloom ${j} parked`).toBeCloseTo(park, 9);
      writeBloomPoses(out, anchors, atPhase(j, 0.3), ...motion);
      expect(out[j].y, `bloom ${j} open`).toBeCloseTo(low, 9);
    }
  });

  it("loops exactly at the cycle, sway and flutter included, and parks unused slots", () => {
    const anchors = bloomAnchors(18, 12);
    const a = poses();
    const b = poses();
    writeBloomPoses(a, anchors, 13.25, ...motion);
    writeBloomPoses(b, anchors, 13.25 + 80 * 7, ...motion);
    for (let j = 0; j < BLOOMS.max; j++) {
      expect(gap(a[j], b[j]), `bloom ${j}`).toBeLessThan(1e-9);
    }
    expect(a[18].toArray()).toEqual([0, BLOOMS.rigY, 0, 0]);
    expect(flutterPhase(13.25 + 80 * 3, 80)).toBeCloseTo(flutterPhase(13.25, 80), 9);
    expect(turnsPerCycle(80, BLOOMS.swaySeconds)).toBe(11);
  });

  it("sways visibly within a few seconds", () => {
    const anchors = bloomAnchors(18, 12);
    const a = poses();
    const b = poses();
    writeBloomPoses(a, anchors, 60, ...motion);
    writeBloomPoses(b, anchors, 63, ...motion);
    for (let j = 0; j < 18; j++) expect(gap(a[j], b[j]), `bloom ${j}`).toBeGreaterThan(0.05);
  });
});

describe("shylight portrait frames", () => {
  it("treats 9:16 as portrait and 16:9 as landscape, easing through the square formats", () => {
    expect(bloomPortrait(9 / 16)).toBe(1);
    expect(bloomPortrait(16 / 9)).toBe(0);
    expect(bloomPortrait(1)).toBeGreaterThan(0);
    expect(bloomPortrait(1)).toBeLessThan(bloomPortrait(4 / 5));
  });
});

describe("shylight presets", () => {
  it("carries a cheap companion rig tinted by its core on every preset", () => {
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      if (!p.lighting) continue;
      expect(companionLightingProblem(p.lighting), p.id).toBeNull();
      expect(p.lighting.lights?.[0]?.color, p.id).toBe(p.colors[2]);
    }
  });
});
