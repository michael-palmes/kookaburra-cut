import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import {
  beginSupersample,
  endSupersample,
  supersampleOffset,
  supersampleSeed,
} from "./supersample";

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

describe("supersampleSeed", () => {
  it("names the draw in flight and returns to 0, so single-sample frames keep their noise", () => {
    const cam = new PerspectiveCamera();
    beginSupersample(cam, 64, 32, 3, 4);
    expect(supersampleSeed.value).toBe(3);
    expect(cam.view?.offsetX).toBe(supersampleOffset(3, 4)[0]);
    endSupersample(cam);
    expect(supersampleSeed.value).toBe(0);
    expect(cam.view?.enabled ?? false).toBe(false);
  });
});
