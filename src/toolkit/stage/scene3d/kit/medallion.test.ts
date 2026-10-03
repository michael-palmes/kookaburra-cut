import { describe, expect, it } from "vitest";
import { createLookMaterial } from "./material";
import {
  LOOK_GLSL_MEDALLION,
  MEDALLION_MIN_HALF_PX,
  medallionLine,
  medallionTurn,
} from "./medallion";

const integral = (halfWidth: number, px: number): number => {
  const step = px / 200;
  let sum = 0;
  for (let d = -halfWidth - 4 * px; d <= halfWidth + 4 * px; d += step) {
    sum += medallionLine(d, halfWidth, px) * step;
  }
  return sum;
};

describe("LOOK_GLSL_MEDALLION", () => {
  it("declares the public helpers, include-guarded", () => {
    for (const fn of ["medAngle", "medLobe", "medLine", "medCeilingLeave"]) {
      expect(new RegExp(`\\bfloat ${fn}\\s*\\(`).test(LOOK_GLSL_MEDALLION), fn).toBe(true);
    }
    expect(LOOK_GLSL_MEDALLION).toContain("#ifndef KK_LOOK_MEDALLION");
  });

  it("passes the look material rules inside a vertex stage (no derivatives)", () => {
    const vertexShader = `${LOOK_GLSL_MEDALLION}
varying float vLeave;
void main() {
  vec4 w = lookWorldPosition(position);
  vLeave = medCeilingLeave(w.xyz);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
    const fragmentShader = `varying float vLeave;
void main() {
  gl_FragColor = vec4(vec3(vLeave), 1.0);
  #include <colorspace_fragment>
}`;
    expect(() =>
      createLookMaterial({ key: "medallion-test/ceiling", vertexShader, fragmentShader }),
    ).not.toThrow();
  });

  it("passes the look material rules inside a fragment", () => {
    const fragmentShader = `${LOOK_GLSL_MEDALLION}
varying vec3 vWorld;
void main() {
  float px = length(fwidth(vWorld.xz));
  float line = medLine(length(vWorld.xz) - 10.0, 0.05, px) * medLobe(atan(vWorld.z, vWorld.x), 0.0, 0.3);
  gl_FragColor = vec4(vec3(line), 1.0);
  #include <colorspace_fragment>
}`;
    expect(() => createLookMaterial({ key: "medallion-test/floor", fragmentShader })).not.toThrow();
  });
});

describe("medallionLine", () => {
  it("keeps the mean tone at any pixel size: the integral is the line width", () => {
    for (const px of [0.01, 0.05, 0.2, 1]) {
      expect(integral(0.035, px), `px ${px}`).toBeCloseTo(0.07, 3);
    }
  });

  it("fades coverage instead of thinning below the pixel floor", () => {
    expect(medallionLine(0, 0.5, 0.1)).toBe(1);
    const thin = medallionLine(0, 0.01, 0.1);
    expect(thin).toBeCloseTo(0.01 / (0.1 * MEDALLION_MIN_HALF_PX), 6);
    expect(medallionLine(0.1 * MEDALLION_MIN_HALF_PX + 0.06, 0.01, 0.1)).toBe(0);
  });
});

describe("medallionTurn", () => {
  it("wraps into one turn, negative-safe, and closes exactly on the period", () => {
    expect(medallionTurn(0, 300)).toBe(0);
    expect(medallionTurn(75, 300)).toBeCloseTo(Math.PI / 2, 12);
    expect(medallionTurn(375, 300)).toBeCloseTo(medallionTurn(75, 300), 12);
    expect(medallionTurn(-75, 300)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(medallionTurn(600, 300)).toBe(0);
  });

  it("scales the rate by turns", () => {
    expect(medallionTurn(50, 300, 2)).toBeCloseTo(medallionTurn(100, 300), 12);
  });
});
