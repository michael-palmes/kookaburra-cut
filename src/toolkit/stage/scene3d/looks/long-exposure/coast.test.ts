import { describe, expect, it } from "vitest";
import {
  COAST_PART,
  coastGeometry,
  coastLayout,
  headlandCrest,
  headlandUniformValues,
  lampBeamAngle,
  lampPosition,
  SEA,
  SEA_HORIZON_Y,
  SEA_RADIUS,
} from "./coast";
import { look, presets } from "./index";

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

function crestSamples(coast: number, scale: number) {
  return coastLayout(coast).heads.flatMap((h) =>
    Array.from({ length: 201 }, (_, k) => {
      const az = h.azimuth + (k / 200 - 0.5) * h.span * 0.999;
      return { h, az, crest: headlandCrest(h, az * DEG, scale) };
    }),
  );
}

describe("long-exposure coast", () => {
  it("ends the sea exactly on the dome, so the dome's horizon is its far edge", () => {
    expect(SEA_RADIUS ** 2 + SEA.y ** 2).toBeCloseTo(SEA.domeRadius ** 2, 9);
    expect(SEA_HORIZON_Y).toBeCloseTo(SEA.y / SEA.domeRadius, 12);
    expect(SEA.y).toBeLessThan(-2);
  });

  it("mirrors coastlines 1 and 2 as 3 and 4 and clamps the slider", () => {
    for (const [mirror, base] of [
      [3, 1],
      [4, 2],
    ]) {
      const a = coastLayout(base).heads;
      const b = coastLayout(mirror).heads;
      b.forEach((h, i) => {
        expect(h.azimuth).toBe(-a[i].azimuth);
        expect(h.tip).toBe(a[i].tip === 0 ? 0 : -a[i].tip);
        expect(h.radius).toBe(a[i].radius);
      });
    }
    expect(coastLayout(0)).toBe(coastLayout(1));
    expect(coastLayout(9)).toEqual(coastLayout(4));
    expect(coastLayout(Number.NaN)).toBe(coastLayout(1));
  });

  it("keeps every headland 20 to 62 units out, off the frame's centre and below the headline", () => {
    for (let coast = 1; coast <= 4; coast++) {
      const { heads } = coastLayout(coast);
      expect(heads.length).toBeLessThanOrEqual(SEA.maxHeadlands);
      for (const h of heads) {
        expect(h.radius).toBeGreaterThanOrEqual(20);
        expect(h.radius).toBeLessThanOrEqual(62);
        const off = Math.abs(((((h.azimuth + 180) % 360) + 360) % 360) - 180);
        expect(off - h.span / 2, `coast ${coast} az ${h.azimuth}`).toBeGreaterThanOrEqual(10);
      }
      for (const { h, crest } of crestSamples(coast, look.params.headlands.max)) {
        const top = SEA.y + crest;
        expect(Math.atan2(top, h.radius) / DEG).toBeLessThan(6);
      }
    }
  });

  it("draws a crest that rises off the tail, peaks inside the slider's mesh and drops at the cliff", () => {
    for (let coast = 1; coast <= 4; coast++) {
      for (const h of coastLayout(coast).heads) {
        const at = (w: number) => headlandCrest(h, (h.azimuth + w * (h.span / 2)) * DEG, 1);
        expect(headlandCrest(h, (h.azimuth + h.span) * DEG, 1)).toBe(0);
        let peak = 0;
        for (let k = -100; k <= 100; k++) peak = Math.max(peak, at(k / 100.5));
        expect(peak).toBeGreaterThan(0.5 * h.height);
        expect(peak).toBeLessThanOrEqual(h.height * 1.2);
        if (h.tip !== 0) {
          expect(at(0.995 * h.tip)).toBeLessThan(0.2 * peak);
          expect(at(-0.995 * h.tip)).toBeLessThan(0.05 * peak);
        }
      }
    }
    const h = coastLayout(1).heads[0];
    expect(headlandCrest(h, h.azimuth * DEG, 0)).toBe(0);
    expect(headlandCrest(h, h.azimuth * DEG, 1.5)).toBeCloseTo(
      1.5 * headlandCrest(h, h.azimuth * DEG, 1),
      9,
    );
  });

  it("sets the lamp on its headland's crest, out on the cliff side", () => {
    for (let coast = 1; coast <= 4; coast++) {
      const { heads, lamp } = coastLayout(coast);
      const h = heads[lamp.head];
      const [x, y, z] = lampPosition(coast, 1);
      expect(Math.hypot(x, z)).toBeCloseTo(h.radius, 9);
      const az = Math.atan2(x, -z);
      expect(y).toBeCloseTo(SEA.y + headlandCrest(h, az, 1) + SEA.tower, 9);
      expect(Math.sign(az / DEG - h.azimuth)).toBe(h.tip);
      expect(y).toBeLessThan(1);
    }
  });

  it("turns the beam once a period and loops exactly", () => {
    expect(lampBeamAngle(0)).toBe(0);
    expect(lampBeamAngle(SEA.beamPeriod / 4)).toBeCloseTo(Math.PI / 2, 12);
    for (const t of [0.5, 61.25, 3600.75]) {
      const a = lampBeamAngle(t);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(TAU);
      expect(lampBeamAngle(t + SEA.beamPeriod)).toBeCloseTo(a, 9);
    }
  });

  it("pads the headland uniforms and reports the sea's early-out reach", () => {
    const { head, shape, reach } = headlandUniformValues(2, 1.2);
    expect(head).toHaveLength(SEA.maxHeadlands * 4);
    expect(shape).toHaveLength(SEA.maxHeadlands * 4);
    const heads = coastLayout(2).heads;
    expect(reach[0]).toBe(Math.min(...heads.map((h) => h.radius)));
    expect(reach[1]).toBeCloseTo(Math.max(...heads.map((h) => h.height)) * 1.2 * 1.2, 9);
    expect(head[3]).toBeCloseTo(heads[0].height * 1.2, 9);
    expect(head[2]).toBeCloseTo((heads[0].span / 2) * DEG, 12);
  });

  it("builds inward-facing walls plus roof strips, every arc's index and part tagged", () => {
    const g = coastGeometry(1);
    const pos = g.getAttribute("position");
    const part = g.getAttribute("aCoast");
    const index = g.getIndex();
    expect(index).not.toBeNull();
    const heads = coastLayout(1).heads;
    const verts = heads.reduce((n, h) => n + (Math.max(4, Math.ceil(h.span * 2)) + 1) * 4, 0);
    expect(pos.count).toBe(verts);
    const parts = new Set<number>();
    for (let i = 0; i < part.count; i++) parts.add(part.getY(i));
    expect([...parts].sort()).toEqual(Object.values(COAST_PART).sort());
    const idx = index?.array ?? [];
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      if (part.getY(a) > COAST_PART.top) continue;
      const p = (k: number) => [pos.getX(k), pos.getY(k), pos.getZ(k)];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const e1 = pb.map((v, k) => v - pa[k]);
      const e2 = pc.map((v, k) => v - pa[k]);
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      expect(n[0] * -pa[0] + n[2] * -pa[2]).toBeGreaterThan(0);
    }
    g.dispose();
  });

  it("gives every preset a coastline and keeps p6 on the def's defaults for the new sliders", () => {
    for (const p of presets) {
      expect(Number.isInteger(p.params?.coast), p.id).toBe(true);
    }
    const p6 = presets.find((p) => p.id === "p6");
    for (const key of ["coast", "headlands", "mist", "swell", "lamp"]) {
      expect(p6?.params?.[key], key).toBe(look.params[key].default);
    }
  });
});
