import { describe, expect, it } from "vitest";
import { containImageDimensions } from "./ImageCard";

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
