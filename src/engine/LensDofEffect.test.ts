import { LinearMipmapLinearFilter, type WebGLRenderTarget } from "three";
import { describe, expect, it } from "vitest";
import { LensDofEffect } from "./LensDofEffect";
import { LENS_NEAR_COC, LENS_NEAR_FADE, LENS_NEAR_TAPS } from "./lensDof";

describe("LensDofEffect", () => {
  it("mipmaps the prefilter, so gather taps read a footprint instead of one texel", () => {
    const effect = new LensDofEffect();
    const prefilter = (effect as unknown as { prefilterTarget: WebGLRenderTarget }).prefilterTarget;
    expect(prefilter.texture.generateMipmaps).toBe(true);
    expect(prefilter.texture.minFilter).toBe(LinearMipmapLinearFilter);
  });

  it("hands the composite its full-res blur constants", () => {
    const defines = new LensDofEffect().defines;
    expect(defines.get("LENS_NEAR_COC")).toBe(LENS_NEAR_COC.toFixed(1));
    expect(defines.get("LENS_NEAR_FADE")).toBe(LENS_NEAR_FADE.toFixed(1));
    expect(defines.get("LENS_NEAR_TAPS")).toBe(`${LENS_NEAR_TAPS}`);
  });
});
