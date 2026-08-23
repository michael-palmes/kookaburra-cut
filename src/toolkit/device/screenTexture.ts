import { useLayoutEffect, useMemo } from "react";
import { SRGBColorSpace, type Texture } from "three";

/** A device screen's private copy of a loaded image: sRGB and `flipY = false` for the glTF UV convention. NEVER mutate the loaded texture itself, drei's `useTexture` cache is keyed by URL and app-wide, so setting `flipY` on it renders the same file upside down in every plain-plane consumer (SceneImage, ImageCard, LayeredScreenshot, backdrops). The clone shares the decoded image, so there is no second fetch or decode. */
export function screenImageTexture(source: Texture): Texture {
  const texture = source.clone();
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  return texture;
}

/** `screenImageTexture` memoised on the loaded texture's identity, so a re-render never leaks a GPU texture. */
export function useScreenImageTexture(source: Texture): Texture {
  const texture = useMemo(() => screenImageTexture(source), [source]);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
