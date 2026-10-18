import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeFormat, FORMATS } from "../../engine/format";
import {
  colouredShadowMaterial,
  layeredScreenshotTitleLayout,
  SHADOW_FRAG,
  SHADOW_FRAG_HARD,
} from "./LayeredScreenshot";

describe("shadow shaders", () => {
  it("keeps the soft shadow program source-identical beside the coloured one", () => {
    const hash = createHash("sha256").update(SHADOW_FRAG).digest("hex").slice(0, 16);
    expect(hash).toBe("ac2c1b2ddfd17689");
    expect(SHADOW_FRAG_HARD).not.toBe(SHADOW_FRAG);
    expect(SHADOW_FRAG_HARD).toContain("uniform vec3 uColor;");
  });

  it("builds the coloured shadow untone-mapped with its colour", () => {
    const material = colouredShadowMaterial({
      size: [2, 1],
      half: [1, 0.5],
      radius: 0,
      blur: 0,
      opacity: 0.5,
      colour: "#ffffff",
    });
    expect(material.fragmentShader).toBe(SHADOW_FRAG_HARD);
    expect(material.toneMapped).toBe(false);
    expect(material.uniforms.uColor.value.getHexString()).toBe("ffffff");
    expect(material.uniforms.uOpacity.value).toBe(0.5);
  });
});

describe("layeredScreenshotTitleLayout", () => {
  it.each(["16:9", "9:16"] as const)("reserves a clear title band in %s", (aspect) => {
    const format = computeFormat(FORMATS[aspect]);
    const layout = layeredScreenshotTitleLayout(format, true);
    const safeTop = format.frame.height / 2 - format.safe.top;
    const nominalHalfTitle = format.aspect < 1 ? 0.17 : 0.28;
    const titleBottom = layout.position[1] - nominalHalfTitle;
    const stackTop = safeTop - layout.topInset;

    expect(layout.topInset).toBeGreaterThan(0);
    expect(titleBottom).toBeGreaterThan(stackTop);
    expect(layout.maxWidth).toBe(format.frame.width - format.safe.left - format.safe.right);
  });

  it("preserves the legacy full-frame stack when no title is present", () => {
    expect(layeredScreenshotTitleLayout(computeFormat(FORMATS["16:9"]), false)).toEqual({
      position: [0, 0, 0],
      maxWidth: 0,
      topInset: 0,
    });
  });
});
