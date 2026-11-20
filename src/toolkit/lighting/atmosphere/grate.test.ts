import { createHash } from "node:crypto";
import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createSeededRandom } from "../../../engine/rng";
import {
  type GrateSpec,
  grateBars,
  grateCrossing,
  mergedBars,
  rasterGrate,
  type SpotFrame,
} from "./grate";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const SPEC: GrateSpec = {
  lens: [0, -0.985, 11.488],
  offset: 0.3,
  along: [0.15, 7],
  width: 10,
  slat: [0.01, 0.1],
  gap: [0.01, 0.06],
  wideGap: { p: 0.25, range: [0.08, 0.3] },
  seed: 42,
};
const FRAME: SpotFrame = {
  position: [-7, 4.85, -7.6],
  target: [1, -1.2, -1],
  halfAngle: (50 * Math.PI) / 180,
};
const [LX, LY, LZ] = FRAME.position;

describe("grate", () => {
  it("is a pure function of the spec and pose", () => {
    expect(sha(rasterGrate(SPEC, FRAME, 64))).toBe(sha(rasterGrate(SPEC, FRAME, 64)));
    expect(sha(rasterGrate({ ...SPEC, seed: 43 }, FRAME, 64))).not.toBe(
      sha(rasterGrate(SPEC, FRAME, 64)),
    );
  });

  it("lays sorted, separate bars inside the row", () => {
    const bars = grateBars(SPEC);
    expect(bars.length).toBeGreaterThan(20);
    bars.forEach(([a, b], i) => {
      expect(b).toBeGreaterThan(a);
      expect(b).toBeLessThanOrEqual(SPEC.width / 2);
      if (i > 0) expect(a).toBeGreaterThan(bars[i - 1][1]);
    });
  });

  it("keeps every point along one camera ray in the same shaft", () => {
    const crossing = grateCrossing(SPEC, FRAME);
    const rand = createSeededRandom(5);
    const [ex, ey, ez] = SPEC.lens;
    let checked = 0;
    for (let k = 0; k < 400; k++) {
      const tx = -4 + 8 * rand();
      const ty = -1.5 + 6 * rand();
      const tz = -6 + 6 * rand();
      const from = (s: number): [number, number, number] => [
        ex + s * (tx - ex) - LX,
        ey + s * (ty - ey) - LY,
        ez + s * (tz - ez) - LZ,
      ];
      const near = crossing(from(0.7));
      const far = crossing(from(1.1));
      if (Number.isNaN(near) || Number.isNaN(far)) continue;
      expect(Math.abs(near - far)).toBeLessThan(1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("lines up with the light's shadow camera", () => {
    const size = 256;
    const bytes = rasterGrate(SPEC, FRAME, size);
    const cam = new PerspectiveCamera((FRAME.halfAngle * 360) / Math.PI, 1, 0.5, 40);
    cam.position.set(LX, LY, LZ);
    cam.lookAt(new Vector3(...FRAME.target));
    cam.updateMatrixWorld();
    const crossing = grateCrossing(SPEC, FRAME);
    const bars = grateBars(SPEC);
    const inBar = (x: number) => bars.some(([a, b]) => x >= a && x <= b);
    const rand = createSeededRandom(9);
    let total = 0;
    let agree = 0;
    for (let k = 0; k < 600; k++) {
      const p = new Vector3(-4 + 8 * rand(), -1.9 + 6 * rand(), -6 + 6 * rand());
      const ndc = p.clone().project(cam);
      if (Math.abs(ndc.x) > 0.95 || Math.abs(ndc.y) > 0.95 || ndc.z > 1) continue;
      const i = Math.floor((ndc.x * 0.5 + 0.5) * size);
      const j = Math.floor((ndc.y * 0.5 + 0.5) * size);
      const byte = bytes[(j * size + i) * 4];
      if (byte !== 0 && byte !== 255) continue;
      const x = crossing([p.x - LX, p.y - LY, p.z - LZ]);
      const expected = Number.isNaN(x) || !inBar(x) ? 255 : 0;
      total++;
      if (byte === expected) agree++;
    }
    expect(total).toBeGreaterThan(100);
    expect(agree / total).toBeGreaterThan(0.97);
  });

  it("merges nested and overlapping hand-placed bars, so none leaks light", () => {
    const raster = (...bars: [number, number][]) => sha(rasterGrate({ ...SPEC, bars }, FRAME, 64));
    const outer = raster([-5, 5]);
    expect(raster([-5, 5], [-1, -0.5])).toBe(outer);
    expect(raster([-1, -0.5], [-5, 0], [-0.2, 5])).toBe(outer);
    const merged = mergedBars([
      [2, 3],
      [-5, 5],
      [-1, -0.5],
      [6, 7],
    ] as [number, number][]);
    expect(merged).toEqual([
      [-5, 5],
      [6, 7],
    ] as [number, number][]);
  });

  it("leaves separate and touching hand-placed bars as they were, only sorted", () => {
    const bars: [number, number][] = [
      [0.5, 0.9],
      [-2, -1],
      [-1, -0.4],
      [1.2, 1.25],
    ];
    expect(mergedBars(bars)).toEqual([...bars].sort((a, b) => a[0] - b[0]));
    expect(bars[0]).toEqual([0.5, 0.9]);
  });
});
