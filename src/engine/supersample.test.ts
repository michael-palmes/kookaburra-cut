import { describe, expect, it } from "vitest";
import { supersampleOffset } from "./supersample";

describe("supersampleOffset", () => {
  it("spreads distinct offsets inside the pixel, centred on it", () => {
    for (const count of [4, 8, 16]) {
      const offsets = Array.from({ length: count }, (_, k) => supersampleOffset(k, count));
      expect(new Set(offsets.map((o) => o.join(","))).size).toBe(count);
      for (const [x, y] of offsets) {
        expect(Math.abs(x)).toBeLessThan(0.5);
        expect(Math.abs(y)).toBeLessThan(0.5);
      }
      const mean = offsets.reduce((m, [x, y]) => [m[0] + x / count, m[1] + y / count], [0, 0]);
      expect(Math.abs(mean[0])).toBeLessThan(0.07);
      expect(Math.abs(mean[1])).toBeLessThan(0.07);
    }
  });
});
