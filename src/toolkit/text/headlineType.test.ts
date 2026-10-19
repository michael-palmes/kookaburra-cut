import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { fontUrl } from "../../theme/fonts";
import type { Theme } from "../../theme/tokens";
import { resolveHeadlineType } from "./headlineType";

const theme = {
  typography: {
    headline: { family: "Inter", weight: 600 },
    body: { family: "Inter", weight: 400 },
  },
} as unknown as Theme;
const doc = (textStyle: Record<string, string | number>) => ({ version: 1, textStyle }) as SceneDoc;

describe("resolveHeadlineType", () => {
  it("uses the theme face at the headline default size", () => {
    expect(resolveHeadlineType(theme, null, {})).toEqual({
      fontRef: { family: "Inter", weight: 600 },
      font: fontUrl({ family: "Inter", weight: 600 }),
      fontSize: 0.6,
    });
    expect(resolveHeadlineType(theme, null, { face: "body", fontSize: 0.4 }).fontSize).toBe(0.4);
  });

  it("applies the sidecar Font, Size and LineHeight for the text key", () => {
    const styled = doc({ titleFont: "Lora", titleSize: 1.5, titleLineHeight: 1.1 });
    expect(resolveHeadlineType(theme, styled, { textKey: "title", fontSize: 0.4 })).toEqual({
      fontRef: { family: "Lora", weight: 400 },
      font: fontUrl({ family: "Lora", weight: 400 }),
      fontSize: 0.4 * 1.5,
      lineHeight: 1.1,
    });
    expect(resolveHeadlineType(theme, styled, { textKey: "other" }).fontSize).toBe(0.6);
  });

  it("reads a styleKey over the text key, and keeps a coded line height", () => {
    const styled = doc({ legacySize: 2 });
    expect(
      resolveHeadlineType(theme, styled, { textKey: "title", styleKey: "legacy" }).fontSize,
    ).toBe(1.2);
    expect(resolveHeadlineType(theme, null, { lineHeight: 1.3 }).lineHeight).toBe(1.3);
  });
});
