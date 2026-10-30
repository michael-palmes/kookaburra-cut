import { afterEach, describe, expect, it, vi } from "vitest";
import { isImageBitmap, orientedBitmap, rememberBakedFlipY } from "./bitmapOrientation";

class FakeBitmap {
  constructor(public readonly tag: string) {}
}

const scope = globalThis as unknown as {
  ImageBitmap?: unknown;
  createImageBitmap?: unknown;
};

afterEach(() => {
  scope.ImageBitmap = undefined;
  scope.createImageBitmap = undefined;
});

describe("orientedBitmap", () => {
  it("is not a bitmap in a realm without ImageBitmap", () => {
    expect(isImageBitmap({})).toBe(false);
  });

  it("hands back the bitmap itself when it was baked for that flipY", async () => {
    scope.ImageBitmap = FakeBitmap;
    const bitmap = new FakeBitmap("plane") as unknown as ImageBitmap;
    rememberBakedFlipY(bitmap, true);
    const same = orientedBitmap(bitmap, true) as Promise<ImageBitmap> & {
      status?: string;
      value?: unknown;
    };
    expect(same.status).toBe("fulfilled");
    expect(same.value).toBe(bitmap);
    expect(await same).toBe(bitmap);
  });

  it("row-reverses once per bitmap and orientation, straight alpha, no colour conversion", async () => {
    scope.ImageBitmap = FakeBitmap;
    const create = vi.fn(async (_source: unknown, _options: unknown) => new FakeBitmap("screen"));
    scope.createImageBitmap = create;
    const bitmap = new FakeBitmap("plane") as unknown as ImageBitmap;
    rememberBakedFlipY(bitmap, true);
    const first = orientedBitmap(bitmap, false);
    const second = orientedBitmap(bitmap, false);
    expect(second).toBe(first);
    const flipped = await first;
    expect((flipped as unknown as FakeBitmap).tag).toBe("screen");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toEqual({
      imageOrientation: "flipY",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    // The copy knows its own orientation, so asking for it again is free.
    expect(await orientedBitmap(flipped, false)).toBe(flipped);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("treats an unrecorded bitmap as three's default flipY", () => {
    scope.ImageBitmap = FakeBitmap;
    const bitmap = new FakeBitmap("unknown") as unknown as ImageBitmap;
    expect((orientedBitmap(bitmap, true) as Promise<ImageBitmap> & { value?: unknown }).value).toBe(
      bitmap,
    );
  });
});
