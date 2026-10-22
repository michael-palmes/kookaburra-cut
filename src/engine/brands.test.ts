import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const {
  activeBrandColours,
  brandCategories,
  brandCategoryLabel,
  normaliseBrand,
  setActiveProjectBrand,
} = await import("./brands");

const ACME = {
  slug: "acme",
  id: "ws:acme",
  name: "Acme",
  description: "One-line summary.",
  themes: ["ws:acme-dark"],
  defaultTheme: "ws:acme-dark",
  typography: { headline: "Acme Serif@400" },
  colors: [{ name: "Ink", hex: "#151E29", role: "primary", note: "Default background." }],
  gradients: ["acme-ink-glow"],
  fonts: [{ family: "Acme Serif", weight: 400 }],
  hasGuidelines: true,
  imageCount: 4,
};

describe("normaliseBrand", () => {
  it("keeps a well-formed summary", () => {
    expect(normaliseBrand(ACME)).toEqual({
      ...ACME,
      typography: { headline: "Acme Serif@400", body: undefined },
      colors: [{ name: "Ink", hex: "#151E29", role: "primary", note: "Default background." }],
    });
  });

  it("defaults malformed fields and drops nameless entries", () => {
    const brand = normaliseBrand({ slug: "beta", name: "Beta", themes: "x", colors: [{}, null] });
    expect(brand).toMatchObject({
      id: "ws:beta",
      themes: [],
      colors: [],
      fonts: [],
      hasGuidelines: false,
      imageCount: 0,
    });
    expect(normaliseBrand({ slug: "nameless" })).toBeNull();
    expect(normaliseBrand(null)).toBeNull();
  });
});

describe("brand categories", () => {
  it("labels folders and keeps listing order", () => {
    expect(brandCategoryLabel("product")).toBe("Product");
    expect(brandCategoryLabel("app_icons")).toBe("App icons");
    expect(brandCategoryLabel("")).toBe("Other");
    const image = (category: string, rel: string) => ({
      path: `/x/${rel}`,
      rel,
      category,
      name: rel,
      bytes: 1,
      modifiedMs: 0,
    });
    expect(
      brandCategories([
        image("", "a.png"),
        image("logos", "logos/a.png"),
        image("logos", "logos/b.png"),
        image("product", "product/a.png"),
      ]),
    ).toEqual(["", "logos", "product"]);
  });
});

describe("the open project's brand", () => {
  beforeEach(() => {
    invoke.mockReset();
    setActiveProjectBrand(null, undefined);
  });

  it("resolves the manifest id to its colours, and clears on switch", async () => {
    invoke.mockResolvedValue([ACME]);
    setActiveProjectBrand("product-tour", "ws:acme");
    await vi.waitFor(() => expect(activeBrandColours()).toHaveLength(1));
    expect(invoke).toHaveBeenCalledWith("list_brands");
    setActiveProjectBrand("other", undefined);
    expect(activeBrandColours()).toEqual([]);
  });

  it("re-binding the same brand never re-lists", async () => {
    invoke.mockResolvedValue([ACME]);
    setActiveProjectBrand("product-tour", "ws:acme");
    await vi.waitFor(() => expect(activeBrandColours()).toHaveLength(1));
    setActiveProjectBrand("product-tour", "ws:acme");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
