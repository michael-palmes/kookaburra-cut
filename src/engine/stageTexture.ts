import { Texture } from "three";

/**
 * PNGs reach the stage byte for byte. WebKit's `createImageBitmap` premultiplies and unmultiplies
 * a PNG with alpha on the way in, whatever `premultiplyAlpha` asks, so every semi-transparent
 * texel lands off the file, while the window's `<img>` upload was the file's bytes. The worker
 * sends PNG bytes to `decode_png` instead and uploads the straight rows as texture data.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The eight-byte PNG signature, whatever the URL or content type said. */
export function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

export interface DecodedPng {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Splits `decode_png`'s reply: width and height as little-endian u32, then straight RGBA8 rows, top row first. */
export function parseDecodedPng(reply: ArrayBuffer): DecodedPng {
  if (reply.byteLength < 8) throw new Error("decoded PNG reply is too short");
  const view = new DataView(reply);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (reply.byteLength !== 8 + width * height * 4) {
    throw new Error(`decoded PNG reply is ${reply.byteLength} bytes for ${width}×${height}`);
  }
  return { data: new Uint8Array(reply, 8), width, height };
}

function isDecodedPng(image: unknown): image is DecodedPng {
  return typeof image === "object" && image !== null && "data" in image;
}

/** The stage loader's texture: a plain Texture (its defaults, its clones) that three uploads as data whenever its image is decoded rows rather than a bitmap. */
export class StageTexture extends Texture {
  get isDataTexture(): boolean {
    return isDecodedPng(this.image);
  }
}
