import { NoColorSpace, SRGBColorSpace, Texture } from "three";
import { describe, expect, it } from "vitest";
import { screenImageTexture } from "./screenTexture";

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

describe("screenImageTexture", () => {
  it("gives the screen a private sRGB copy on the glTF flipY convention", () => {
    const clone = screenImageTexture(new Texture());
    expect(clone.flipY).toBe(false);
    expect(clone.colorSpace).toBe(SRGBColorSpace);
  });

  // The regression pin for the upside-down image: drei caches one texture per URL, so a write here flips the same file everywhere else it is used.
  it("leaves the loaded texture untouched", () => {
    const loaded = new Texture();
    const clone = screenImageTexture(loaded);
    expect(clone).not.toBe(loaded);
    expect(loaded.flipY).toBe(true);
    expect(loaded.colorSpace).toBe(NoColorSpace);
  });

  it("shares the decoded image, so there is no second fetch or decode", () => {
    const loaded = new Texture();
    expect(screenImageTexture(loaded).source).toBe(loaded.source);
  });

  it.each(["./Device.tsx", "./DeviceMockup.tsx"])("%s never writes flipY itself", (file) => {
    expect(read(file)).not.toMatch(/\.flipY\s*=/);
  });
});
