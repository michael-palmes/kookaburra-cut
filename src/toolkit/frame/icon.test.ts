import { describe, expect, it } from "vitest";
import { isAssetReference } from "./icon";

describe("isAssetReference", () => {
  it("treats assets/ paths and image extensions as assets", () => {
    expect(isAssetReference("assets/app-icon.png")).toBe(true);
    expect(isAssetReference("logo.webp")).toBe(true);
    expect(isAssetReference("art/badge.JPG")).toBe(true);
  });

  it("treats emoji, glyphs and words as text", () => {
    expect(isAssetReference("🚀")).toBe(false);
    expect(isAssetReference("✓")).toBe(false);
    expect(isAssetReference("Beta")).toBe(false);
  });
});
