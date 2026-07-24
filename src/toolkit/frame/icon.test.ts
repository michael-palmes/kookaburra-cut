import { describe, expect, it } from "vitest";
import { isAssetReference, isUnloadableAssetPath } from "./icon";

describe("isAssetReference", () => {
  it("treats known image extensions as assets", () => {
    expect(isAssetReference("assets/app-icon.png")).toBe(true);
    expect(isAssetReference("logo.webp")).toBe(true);
    expect(isAssetReference("art/badge.JPG")).toBe(true);
  });

  it("treats emoji, glyphs and words as text", () => {
    expect(isAssetReference("🚀")).toBe(false);
    expect(isAssetReference("✓")).toBe(false);
    expect(isAssetReference("Beta")).toBe(false);
  });

  it("rejects a path with a half-typed extension", () => {
    expect(isAssetReference("assets/test.pn")).toBe(false);
    expect(isAssetReference("assets/test")).toBe(false);
  });
});

describe("isUnloadableAssetPath", () => {
  it("flags path-like strings without an image extension", () => {
    expect(isUnloadableAssetPath("assets/test.pn")).toBe(true);
    expect(isUnloadableAssetPath("assets/test")).toBe(true);
    expect(isUnloadableAssetPath("assets")).toBe(true);
    expect(isUnloadableAssetPath("art/badge")).toBe(true);
  });

  it("passes loadable images, emoji and words through", () => {
    expect(isUnloadableAssetPath("assets/app-icon.png")).toBe(false);
    expect(isUnloadableAssetPath("🚀")).toBe(false);
    expect(isUnloadableAssetPath("Beta")).toBe(false);
  });
});
