import { describe, expect, it } from "vitest";
import { containImageDimensions, imageCardOpacity } from "./ImageCard";

describe("imageCardOpacity", () => {
  it("runs the legacy fade exactly when nothing new is set", () => {
    expect(imageCardOpacity({}, 500)).toBe(1);
    expect(imageCardOpacity({ from: 100, to: 300 }, 200)).toBe(0.5);
    expect(imageCardOpacity({ from: 300, to: 100 }, 0)).toBe(1);
  });

  it("multiplies opacity with the fade-in", () => {
    expect(imageCardOpacity({ opacity: 0.5 }, 0)).toBe(0.5);
    expect(imageCardOpacity({ from: 0, to: 100, opacity: 0.5 }, 50)).toBe(0.25);
    expect(imageCardOpacity({ opacity: 4 }, 0)).toBe(1);
  });

  it("fades out over the fade-in's length, else 300 ms, unless it's told", () => {
    expect(imageCardOpacity({ outAt: 1000 }, 999)).toBe(1);
    expect(imageCardOpacity({ outAt: 1000 }, 1150)).toBe(0.5);
    expect(imageCardOpacity({ outAt: 1000 }, 1300)).toBe(0);
    expect(imageCardOpacity({ from: 0, to: 100, outAt: 1000 }, 1050)).toBe(0.5);
    expect(imageCardOpacity({ outAt: 1000, outDurationMs: 200 }, 1100)).toBe(0.5);
  });
});

describe("containImageDimensions", () => {
  it("preserves square icon tuning at the declared bounds", () => {
    expect(containImageDimensions(512, 512, 1.3, 1.3)).toEqual({ width: 1.3, height: 1.3 });
  });

  it("keeps wide icons at the declared width", () => {
    expect(containImageDimensions(800, 400, 1.3, 1.3)).toEqual({ width: 1.3, height: 0.65 });
  });

  it("shrinks portrait icons into the declared square", () => {
    expect(containImageDimensions(400, 800, 1.3, 1.3)).toEqual({ width: 0.65, height: 1.3 });
  });
});
