import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import {
  beginSupersample,
  createFrameShare,
  endSupersample,
  setSupersampleSharing,
  supersampleCount,
  supersampleOffset,
  supersampleSeed,
  unshareSupersampleDraw,
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

describe("supersample sharing", () => {
  const cam = new PerspectiveCamera();
  const draw = (k: number) => beginSupersample(cam, 64, 32, k, 16);

  it("tells the haze how many draws share the frame, and 1 outside one", () => {
    draw(0);
    expect(supersampleCount.value).toBe(16);
    endSupersample(cam);
    expect(supersampleCount.value).toBe(1);
  });

  it("makes once-a-frame work in the first draw and reuses it in the rest", () => {
    const share = createFrameShare();
    expect(share.reuse()).toBe(false);
    draw(0);
    expect(share.reuse()).toBe(false);
    draw(1);
    expect(share.reuse()).toBe(true);
    draw(2);
    expect(share.reuse()).toBe(true);
    endSupersample(cam);
    expect(share.reuse()).toBe(false);
    draw(0);
    expect(share.reuse()).toBe(false);
    endSupersample(cam);
  });

  it("reuses within a draw too, and nothing after a reset or in a draw that opted out", () => {
    const share = createFrameShare();
    draw(0);
    expect(share.reuse()).toBe(false);
    expect(share.reuse()).toBe(true);
    share.reset();
    expect(share.reuse()).toBe(false);
    draw(1);
    unshareSupersampleDraw();
    expect(share.reuse()).toBe(false);
    expect(share.reuse()).toBe(false);
    draw(2);
    expect(share.reuse()).toBe(false);
    draw(3);
    expect(share.reuse()).toBe(true);
    endSupersample(cam);
  });

  it("shares nothing with the lever off", () => {
    const share = createFrameShare();
    setSupersampleSharing(false);
    try {
      draw(0);
      expect(supersampleCount.value).toBe(1);
      expect(share.reuse()).toBe(false);
      draw(1);
      expect(share.reuse()).toBe(false);
      endSupersample(cam);
    } finally {
      setSupersampleSharing(true);
    }
  });
});
