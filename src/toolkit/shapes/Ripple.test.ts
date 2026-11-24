import { describe, expect, it } from "vitest";
import { rippleAt, rippleRingGeometry } from "./Ripple";

describe("ripple", () => {
  it("builds a unit ring that is flat, and faces straight out, at both edges", () => {
    const geometry = rippleRingGeometry(0.4);
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    let peak = 0;
    for (let i = 0; i < positions.count; i++) {
      const r = Math.hypot(positions.getX(i), positions.getY(i));
      const z = positions.getZ(i);
      expect(r).toBeGreaterThanOrEqual(0.6 - 1e-6);
      expect(r).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))).toBeCloseTo(1, 5);
      if (Math.abs(r - 1) < 1e-6 || Math.abs(r - 0.6) < 1e-6) {
        expect(z).toBeCloseTo(0, 6);
        expect(normals.getZ(i)).toBeCloseTo(1, 5);
      }
      peak = Math.max(peak, z);
    }
    expect(peak).toBeCloseTo(1, 6);
    const train = rippleRingGeometry(0.4, 2).getAttribute("position");
    let tallest = 0;
    for (let i = 0; i < train.count; i++) tallest = Math.max(tallest, train.getZ(i));
    expect(tallest).toBeGreaterThan(0.6);
    expect(tallest).toBeLessThanOrEqual(1);
  });

  it("winds every face to the front, the side its normals point to", () => {
    const geometry = rippleRingGeometry(0.4);
    const positions = geometry.getAttribute("position");
    const index = geometry.getIndex();
    for (let i = 0; i < (index?.count ?? 0); i += 3) {
      const [a, b, c] = [index?.getX(i) ?? 0, index?.getX(i + 1) ?? 0, index?.getX(i + 2) ?? 0];
      const ux = positions.getX(b) - positions.getX(a);
      const uy = positions.getY(b) - positions.getY(a);
      const vx = positions.getX(c) - positions.getX(a);
      const vy = positions.getY(c) - positions.getY(a);
      expect(ux * vy - uy * vx).toBeGreaterThan(0);
    }
  });

  it("is still before it starts and once it has gone", () => {
    expect(rippleAt(-1, 0.4, 600).swell).toBe(0);
    expect(rippleAt(600, 0.4, 600).swell).toBe(0);
    expect(rippleAt(900, 0.4, 600).swell).toBe(0);
  });

  it("opens outwards the whole way and never past its radius", () => {
    let last = 0;
    for (let ms = 0; ms <= 600; ms += 20) {
      const ring = rippleAt(ms, 0.4, 600);
      expect(ring.radius).toBeGreaterThanOrEqual(last);
      expect(ring.radius).toBeLessThanOrEqual(0.4 + 1e-9);
      expect(ring.swell).toBeGreaterThanOrEqual(0);
      expect(ring.swell).toBeLessThanOrEqual(1);
      last = ring.radius;
    }
    expect(rippleAt(150, 0.4, 600).swell).toBeGreaterThan(rippleAt(450, 0.4, 600).swell);
  });
});
