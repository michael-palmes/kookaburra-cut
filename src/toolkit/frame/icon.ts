/** Routes a frame icon or chip mark to its renderer: a loadable image path draws through `ImageCard`, a path-like string without a known image extension (a half-typed inspector value) draws NOTHING, and anything else (an emoji, a "✓" tick, a letter) draws as text. Pure. See docs/overlays.md. */

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

export function isAssetReference(value: string): boolean {
  return IMAGE_EXTENSION.test(value);
}

/** Path-like but not loadable as an image: never send it to the texture loader or the text pipeline. */
export function isUnloadableAssetPath(value: string): boolean {
  return !IMAGE_EXTENSION.test(value) && (value.includes("/") || value.startsWith("assets"));
}
