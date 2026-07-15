/** Cover-fit UV crop for media on a device screen: the Device primitive maps media (video frames/images) onto a glTF display mesh whose UVs span the screen 0..1, and since media rarely matches the display's aspect exactly, we crop, keeping the media's aspect, filling the screen, and trimming the overflow symmetrically (the "fill content, keep aspect ratio" rule). The crop is baked into a clone of the screen mesh's UV attribute once per scene instance (see `Device`), never onto the texture, since clip-frame textures are LRU-shared per source and texture-level transforms would leak between consumers of the same clip. Pure: same inputs, same rect. See docs/determinism.md. */

/** A UV-space rectangle: sample from (u0, v0) at the screen's UV origin to (u1, v1). */
export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * The UV rectangle of the media that a cover-fit screen shows.
 *
 * @param mediaAspect  media width / height (e.g. an extracted clip's `info.width/height`)
 * @param screenAspect display width / height from the device catalog (portrait phone < 1)
 * @param flipV        flips the V axis; glTF puts v=0 at the top, and pre-flipped clip-frame bitmaps (see `engine/clips.ts`) store the bottom row at v=0, so video needs `flipV: true` while `TextureLoader` images (`flipY = false`) already match glTF and need `flipV: false`.
 */
export function coverCropRect(mediaAspect: number, screenAspect: number, flipV: boolean): UvRect {
  let u0 = 0;
  let v0 = 0;
  let u1 = 1;
  let v1 = 1;
  if (mediaAspect > 0 && screenAspect > 0) {
    if (mediaAspect > screenAspect) {
      // Media is wider than the screen: full height, crop the sides.
      const w = screenAspect / mediaAspect;
      u0 = (1 - w) / 2;
      u1 = u0 + w;
    } else if (mediaAspect < screenAspect) {
      // Media is taller than the screen: full width, crop top/bottom.
      const h = mediaAspect / screenAspect;
      v0 = (1 - h) / 2;
      v1 = v0 + h;
    }
  }
  return flipV ? { u0, v0: v1, u1, v1: v0 } : { u0, v0, u1, v1 };
}

/** Remaps a UV pair from screen space (0..1 across the display) into the crop rect; applied once over a cloned `uv` BufferAttribute. */
export function remapUv(u: number, v: number, rect: UvRect): [number, number] {
  return [rect.u0 + u * (rect.u1 - rect.u0), rect.v0 + v * (rect.v1 - rect.v0)];
}
