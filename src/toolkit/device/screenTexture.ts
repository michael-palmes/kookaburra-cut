import { use, useLayoutEffect, useMemo } from "react";
import { Source, SRGBColorSpace, type Texture } from "three";
import { isImageBitmap, orientedBitmap } from "../../engine/bitmapOrientation";

/** A device screen's private copy of a loaded image: sRGB and `flipY = false` for the glTF UV convention. NEVER mutate the loaded texture itself, drei's `useTexture` cache is keyed by URL and app-wide, so setting `flipY` on it renders the same file upside down in every plain-plane consumer (SceneImage, ImageCard, LayeredScreenshot, backdrops). The clone shares the decoded image, so there is no second fetch or decode, and it resets the UV transform explicitly (the `FixedImageMesh` precedent) so a world-space image backdrop's cover crop, which still writes repeat/offset on the shared texture, can never reach a screen through mount order. The screen's own crop is baked into the mesh UVs. An ImageBitmap carries its orientation in its pixels (WebGL ignores `flipY` for one), so the stage passes the copy oriented for `flipY = false` as `image`; a natively decoded PNG (rows in a `StageTexture`) clones as it is, WebGL flips rows on upload. */
export function screenImageTexture(source: Texture, image: unknown = source.image): Texture {
  const texture = source.clone();
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  texture.repeat.set(1, 1);
  texture.offset.set(0, 0);
  if (image !== source.image) {
    texture.source = new Source(image);
    texture.needsUpdate = true;
  }
  return texture;
}

/** `screenImageTexture` memoised on the loaded texture's identity, so a re-render never leaks a GPU texture; suspends while a bitmap's screen orientation is copied. */
export function useScreenImageTexture(source: Texture): Texture {
  const loaded = source.image;
  const image = isImageBitmap(loaded) ? use(orientedBitmap(loaded, false)) : loaded;
  const texture = useMemo(() => screenImageTexture(source, image), [source, image]);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
