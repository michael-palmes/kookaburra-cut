import { useLayoutEffect, useMemo } from "react";
import { SRGBColorSpace, type Texture } from "three";

/** A device screen's private copy of a loaded image: sRGB and `flipY = false` for the glTF UV convention. NEVER mutate the loaded texture itself, drei's `useTexture` cache is keyed by URL and app-wide, so setting `flipY` on it renders the same file upside down in every plain-plane consumer (SceneImage, ImageCard, LayeredScreenshot, backdrops). The clone shares the decoded image, so there is no second fetch or decode, and it resets the UV transform explicitly (the `FixedImageMesh` precedent) so a world-space image backdrop's cover crop, which still writes repeat/offset on the shared texture, can never reach a screen through mount order. The screen's own crop is baked into the mesh UVs. */
export function screenImageTexture(source: Texture): Texture {
  const texture = source.clone();
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  texture.repeat.set(1, 1);
  texture.offset.set(0, 0);
  return texture;
}

/** `screenImageTexture` memoised on the loaded texture's identity, so a re-render never leaks a GPU texture. */
export function useScreenImageTexture(source: Texture): Texture {
  const texture = useMemo(() => screenImageTexture(source), [source]);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
