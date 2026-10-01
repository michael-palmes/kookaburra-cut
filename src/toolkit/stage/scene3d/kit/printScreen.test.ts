import { describe, expect, it } from "vitest";
import { createLookMaterial } from "./material";
import {
  LOOK_GLSL_PRINT,
  PRINT_SLIP_ANGLE_DEG,
  printBayer,
  printDotRadius,
  printPlateSlip,
  printR2,
} from "./printScreen";

const declares = (fn: string) => new RegExp(`\\b(float|vec2) ${fn}\\s*\\(`).test(LOOK_GLSL_PRINT);

describe("LOOK_GLSL_PRINT", () => {
  it("declares the public helpers, include-guarded", () => {
    for (const fn of [
      "printGrain",
      "printScreen",
      "printInk",
      "printSlip",
      "printBayer",
      "printR2",
      "printDither",
      "printDotRadius",
      "printHalftone",
    ]) {
      expect(declares(fn), fn).toBe(true);
    }
    expect(LOOK_GLSL_PRINT).toContain("#ifndef KK_LOOK_PRINT");
    expect((LOOK_GLSL_PRINT.match(/^#endif\b/gm) ?? []).length).toBe(1);
  });

  it("stays static in time and world anchored", () => {
    expect(/\buTime\b|\btime\b/i.test(LOOK_GLSL_PRINT)).toBe(false);
    expect(LOOK_GLSL_PRINT.includes("gl_FragCoord")).toBe(false);
    expect(/fract\s*\(\s*sin/.test(LOOK_GLSL_PRINT)).toBe(false);
  });

  it("passes the look material rules inside a fragment", () => {
    const fragmentShader = `${LOOK_GLSL_PRINT}
varying vec3 vWorld;
void main() {
  float ink = printInk(0.5, printScreen(vWorld.xz, 0.05, 1.0));
  gl_FragColor = vec4(vec3(ink), 1.0);
  #include <colorspace_fragment>
}`;
    expect(() => createLookMaterial({ key: "print-test/floor", fragmentShader })).not.toThrow();
  });

  it("mirrors the CPU thresholds exactly", () => {
    expect(LOOK_GLSL_PRINT).toContain("uint(c.x) * 3242174889u + uint(c.y) * 2447445414u");
    expect(LOOK_GLSL_PRINT).toContain("((v & 1u) << 5) | ((y & 1u) << 4)");
  });
});

describe("printBayer", () => {
  it("is the 8x8 ordered matrix: a permutation of the 64 levels, 2x2 base [0 2; 3 1]", () => {
    const levels = new Set<number>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) levels.add(printBayer(x, y) * 64 - 0.5);
    expect([...levels].sort((a, b) => a - b)).toEqual([...Array(64).keys()]);
    expect([printBayer(0, 0), printBayer(1, 0), printBayer(0, 1), printBayer(1, 1)]).toEqual(
      [0, 32, 48, 16].map((m) => (m + 0.5) / 64),
    );
  });

  it("tiles every 8 cells, negative cells included", () => {
    expect(printBayer(-1, -3)).toBe(printBayer(7, 5));
    expect(printBayer(13, 21)).toBe(printBayer(5, 5));
  });
});

describe("printR2", () => {
  it("covers (0, 1) evenly", () => {
    const bins = new Array(8).fill(0);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const t = printR2(x, y);
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
        bins[Math.floor(t * 8)]++;
      }
    }
    for (const b of bins) expect(Math.abs(b - 512)).toBeLessThan(26);
  });

  it("keeps neighbours apart like blue noise (no clumps of like thresholds)", () => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        sum +=
          Math.abs(printR2(x, y) - printR2(x + 1, y)) + Math.abs(printR2(x, y) - printR2(x, y + 1));
        n += 2;
      }
    }
    expect(sum / n).toBeGreaterThan(0.36);
  });

  it("is exact for negative cells", () => {
    expect(printR2(-5, 3)).toBe(printR2(-5, 3));
    expect(printR2(-1, 0)).not.toBe(printR2(1, 0));
  });
});

describe("printDotRadius", () => {
  it("tracks tone by area and merges at full tone", () => {
    expect(printDotRadius(0)).toBe(0);
    expect(printDotRadius(-1)).toBe(0);
    expect(Math.PI * printDotRadius(0.3) ** 2).toBeCloseTo(0.3, 6);
    expect(printDotRadius(Math.PI / 4)).toBeCloseTo(0.5, 6);
    expect(printDotRadius(1)).toBeGreaterThan(Math.SQRT1_2);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const r = printDotRadius(t);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});

describe("printPlateSlip", () => {
  it("sets the two plates `amount` apart along the angle", () => {
    const [x, y] = printPlateSlip(0.1);
    expect(Math.hypot(2 * x, 2 * y)).toBeCloseTo(0.1, 9);
    expect((Math.atan2(y, x) * 180) / Math.PI).toBeCloseTo(PRINT_SLIP_ANGLE_DEG, 9);
    expect(printPlateSlip(0.2, 90)[1]).toBeCloseTo(0.1, 9);
    expect(printPlateSlip(-1).map(Math.abs)).toEqual([0, 0]);
  });
});
