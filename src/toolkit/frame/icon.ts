/** Routes a frame icon or chip mark to its renderer: a project asset path draws through `ImageCard`, anything else (an emoji, a "✓" tick, a letter) draws as text. Pure. An asset reference starts with `assets/` or ends in a known image extension. See docs/overlays.md. */

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

export function isAssetReference(value: string): boolean {
  return value.startsWith("assets/") || IMAGE_EXTENSION.test(value);
}
