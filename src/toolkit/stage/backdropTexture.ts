import { useLayoutEffect, useMemo } from "react";
import { SRGBColorSpace, type Texture } from "three";

/** A world-space image backdrop's private sRGB copy of a loaded image. The cover crop below is a TEXTURE-level transform, and drei's `useTexture` cache is keyed by URL and app-wide, so writing `repeat`/`offset` on the loaded texture would crop the same file in every other consumer (SceneImage, ImageCard, LayeredScreenshot, device screens). The clone shares the decoded image, so there is no second fetch or decode, and it starts from an identity UV transform so whatever mounted first can never ride in. Mirrors `toolkit/device/screenTexture.ts`. */
export function backdropImageTexture(source: Texture): Texture {
  const texture = source.clone();
  texture.colorSpace = SRGBColorSpace;
  texture.repeat.set(1, 1);
  texture.offset.set(0, 0);
  return texture;
}

/** The cover-fit UV transform: fill the plane, keep the image's aspect, trim the overflow symmetrically. Pure, and EXPORT CONTRACT (see docs/determinism.md, "Staging"). */
export function backdropCoverCrop(
  imageAspect: number,
  planeAspect: number,
): { repeat: [number, number]; offset: [number, number] } {
  if (imageAspect > planeAspect) {
    const x = planeAspect / imageAspect;
    return { repeat: [x, 1], offset: [(1 - x) / 2, 0] };
  }
  const y = imageAspect / planeAspect;
  return { repeat: [1, y], offset: [0, (1 - y) / 2] };
}

/** `backdropImageTexture` memoised on the loaded texture's identity, so a re-render never leaks a GPU texture. */
export function useBackdropImageTexture(source: Texture): Texture {
  const texture = useMemo(() => backdropImageTexture(source), [source]);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
