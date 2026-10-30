import { Texture } from "three";
import { describe, expect, it } from "vitest";
import { isPngBytes, parseDecodedPng, StageTexture } from "./stageTexture";

describe("isPngBytes", () => {
  it("recognises the signature and nothing else", () => {
    expect(isPngBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(
      true,
    );
    expect(isPngBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isPngBytes(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false);
  });
});

describe("parseDecodedPng", () => {
  it("reads the size header and the rows behind it", () => {
    const reply = new Uint8Array(8 + 2 * 1 * 4);
    new DataView(reply.buffer).setUint32(0, 2, true);
    new DataView(reply.buffer).setUint32(4, 1, true);
    reply.set([1, 2, 3, 4, 5, 6, 7, 8], 8);
    const decoded = parseDecodedPng(reply.buffer);
    expect([decoded.width, decoded.height]).toEqual([2, 1]);
    expect([...decoded.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("rejects a reply whose length disagrees with its header", () => {
    const reply = new Uint8Array(8 + 3);
    new DataView(reply.buffer).setUint32(0, 1, true);
    new DataView(reply.buffer).setUint32(4, 1, true);
    expect(() => parseDecodedPng(reply.buffer)).toThrow(/11 bytes/);
    expect(() => parseDecodedPng(new ArrayBuffer(4))).toThrow(/too short/);
  });
});

describe("StageTexture", () => {
  it("keeps a plain texture's defaults and uploads as data only when it holds decoded rows", () => {
    const texture = new StageTexture();
    const plain = new Texture();
    for (const key of [
      "flipY",
      "magFilter",
      "minFilter",
      "generateMipmaps",
      "unpackAlignment",
    ] as const) {
      expect(texture[key]).toBe(plain[key]);
    }
    expect(texture.isDataTexture).toBe(false);
    texture.image = { data: new Uint8Array(4), width: 1, height: 1 };
    expect(texture.isDataTexture).toBe(true);
    const clone = texture.clone();
    expect(clone).toBeInstanceOf(StageTexture);
    expect(clone.isDataTexture).toBe(true);
  });
});
