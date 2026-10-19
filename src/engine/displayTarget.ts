import { type RenderTarget, SRGBColorSpace, UnsignedByteType } from "three";

/** Makes an SDR target an offscreen canvas: three applies tone mapping, the in-shader output encode and the clear-colour conversion only for `null` or `isXRRenderTarget` targets (an XR target encodes to its own tag, so pass the renderer's `outputColorSpace`), and RGBA8 storage keeps those bytes raw, so blending, the MSAA resolve and sampling stay in the canvas's domain. Call before the first setRenderTarget (it allocates the storage). */
export function asDisplayTarget<T extends RenderTarget>(target: T, outputColorSpace: string): T {
  (target as T & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  target.texture.colorSpace = outputColorSpace;
  target.texture.internalFormat = "RGBA8";
  return target;
}

export function isDisplayTarget(target: RenderTarget): boolean {
  return (target as RenderTarget & { isXRRenderTarget?: boolean }).isXRRenderTarget === true;
}

/** True when the target hardware-encodes sRGB on store, so a display-domain shader must hand it linear light. */
export function encodesSrgbOnStore(target: RenderTarget | null): boolean {
  if (!target) return false;
  const format = target.texture.internalFormat;
  if (format) return format === "SRGB8_ALPHA8";
  return target.texture.type === UnsignedByteType && target.texture.colorSpace === SRGBColorSpace;
}
