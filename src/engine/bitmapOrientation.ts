/** An ImageBitmap carries its orientation in its pixels: WebGL ignores `flipY` for a bitmap upload, so a texture clone that wants the other orientation needs a re-oriented copy. The stage loader records the orientation it baked; a consumer asks for the one its `flipY` means and suspends on the copy. */

const baked = new WeakMap<ImageBitmap, boolean>();
const copies = new WeakMap<ImageBitmap, Map<boolean, Promise<ImageBitmap>>>();

export function isImageBitmap(image: unknown): image is ImageBitmap {
  return typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap;
}

/** Records that `bitmap` was decoded for a texture whose `flipY` is `flipY` (rows reversed when true). */
export function rememberBakedFlipY(bitmap: ImageBitmap, flipY: boolean): void {
  baked.set(bitmap, flipY);
}

/** A promise React's `use` reads without suspending. */
function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled" as const, value });
}

/** The bitmap as a texture with `flipY` would upload it: `bitmap` itself when it was baked that way, else a row-reversed copy (straight alpha, no colour conversion), one per bitmap and orientation. A bitmap nobody recorded counts as baked for `flipY = true`, three's default. */
export function orientedBitmap(bitmap: ImageBitmap, flipY: boolean): Promise<ImageBitmap> {
  if ((baked.get(bitmap) ?? true) === flipY) return settled(bitmap);
  let perBitmap = copies.get(bitmap);
  if (!perBitmap) {
    perBitmap = new Map();
    copies.set(bitmap, perBitmap);
  }
  let copy = perBitmap.get(flipY);
  if (!copy) {
    copy = createImageBitmap(bitmap, {
      imageOrientation: "flipY",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    }).then((flipped) => {
      baked.set(flipped, flipY);
      return flipped;
    });
    perBitmap.set(flipY, copy);
  }
  return copy;
}
