import { NoColorSpace, SRGBColorSpace, Texture } from "three";
import { describe, expect, it } from "vitest";
import { backdropCoverCrop, backdropImageTexture } from "./backdropTexture";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const read = (file: string) =>
  testProcess.getBuiltinModule("fs").readFileSync(new URL(file, import.meta.url), "utf8");

describe("backdropImageTexture", () => {
  it("gives the backdrop a private sRGB copy on an identity UV transform", () => {
    const clone = backdropImageTexture(new Texture());
    expect(clone.colorSpace).toBe(SRGBColorSpace);
    expect([clone.repeat.x, clone.repeat.y]).toEqual([1, 1]);
    expect([clone.offset.x, clone.offset.y]).toEqual([0, 0]);
  });

  // The regression pin: drei caches one texture per URL, so cropping here would crop the same file in every other consumer.
  it("leaves the loaded texture untouched", () => {
    const loaded = new Texture();
    const clone = backdropImageTexture(loaded);
    expect(clone).not.toBe(loaded);
    expect(loaded.colorSpace).toBe(NoColorSpace);
    expect([loaded.repeat.x, loaded.repeat.y]).toEqual([1, 1]);
  });

  it("shares the decoded image, so there is no second fetch or decode", () => {
    const loaded = new Texture();
    expect(backdropImageTexture(loaded).source).toBe(loaded.source);
  });

  it("does not inherit a crop another consumer left on the shared texture", () => {
    const loaded = new Texture();
    loaded.repeat.set(0.5, 1);
    loaded.offset.set(0.25, 0);
    const clone = backdropImageTexture(loaded);
    expect([clone.repeat.x, clone.repeat.y]).toEqual([1, 1]);
    expect([clone.offset.x, clone.offset.y]).toEqual([0, 0]);
    expect([loaded.repeat.x, loaded.offset.x]).toEqual([0.5, 0.25]);
  });

  it("keeps ImagePlaneMesh off the loaded texture entirely", () => {
    const source = read("./backdrops.tsx");
    const start = source.indexOf("function ImagePlaneMesh(");
    const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("useBackdropImageTexture(texture)");
    expect(body).not.toMatch(/\btexture\.(repeat|offset|colorSpace)\b/);
  });
});

describe("backdropCoverCrop", () => {
  it("trims the sides when the image is wider than the plane", () => {
    expect(backdropCoverCrop(2, 1)).toEqual({ repeat: [0.5, 1], offset: [0.25, 0] });
  });

  it("trims top and bottom when the image is taller than the plane", () => {
    expect(backdropCoverCrop(1, 2)).toEqual({ repeat: [1, 0.5], offset: [0, 0.25] });
  });

  it("is the identity transform at a matching aspect", () => {
    expect(backdropCoverCrop(1.5, 1.5)).toEqual({ repeat: [1, 1], offset: [0, 0] });
  });
});
