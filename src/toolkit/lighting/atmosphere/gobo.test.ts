import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GOBO_DEFAULTS, type GoboSpec, goboSampler, rasterGobo } from "./gobo";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const mean = (spec: GoboSpec, size = 128) => {
  const bytes = rasterGobo(spec, size);
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum += bytes[i];
  return sum / (bytes.length / 4) / 255;
};

describe("gobo raster", () => {
  it("is a pure function of the spec", () => {
    for (const pattern of ["slats", "blinds", "window", "dapple"] as const) {
      const spec = { ...GOBO_DEFAULTS, pattern };
      expect(sha(rasterGobo(spec, 64))).toBe(sha(rasterGobo(spec, 64)));
    }
  });

  it("changes with the seed only where the pattern is seeded", () => {
    const a = { ...GOBO_DEFAULTS, seed: 1 };
    const b = { ...GOBO_DEFAULTS, seed: 2 };
    expect(sha(rasterGobo(a, 64))).not.toBe(sha(rasterGobo(b, 64)));
    const blinds = { ...GOBO_DEFAULTS, pattern: "blinds" as const };
    expect(sha(rasterGobo({ ...blinds, seed: 1 }, 64))).toBe(
      sha(rasterGobo({ ...blinds, seed: 2 }, 64)),
    );
  });

  it("passes about its duty of light through regular blinds", () => {
    for (const duty of [0.3, 0.5, 0.7]) {
      expect(mean({ ...GOBO_DEFAULTS, pattern: "blinds", duty, softness: 0.1 })).toBeCloseTo(
        duty,
        1,
      );
    }
  });

  it("stays inside 0..1 and rotates about the centre", () => {
    const sample = goboSampler({ ...GOBO_DEFAULTS, pattern: "blinds", angleDeg: 90 });
    const upright = goboSampler({ ...GOBO_DEFAULTS, pattern: "blinds", angleDeg: 0 });
    for (let k = 0; k < 50; k++) {
      const t = k / 49;
      expect(sample(0.37, t)).toBeCloseTo(upright(1 - t, 0.37), 6);
      expect(sample(t, 0.5)).toBeGreaterThanOrEqual(0);
      expect(sample(t, 0.5)).toBeLessThanOrEqual(1);
    }
  });
});
