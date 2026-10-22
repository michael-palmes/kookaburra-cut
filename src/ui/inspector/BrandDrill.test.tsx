import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrandSummary } from "../../engine/brands";
import { BrandDrill, NO_BRANDS_HINT } from "./BrandDrill";

const ACME: BrandSummary = {
  slug: "acme",
  id: "ws:acme",
  name: "Acme",
  description: "One-line summary.",
  themes: ["ws:acme-dark"],
  defaultTheme: "ws:acme-dark",
  typography: {},
  colors: [{ name: "Ink", hex: "#151E29" }],
  gradients: [],
  fonts: [],
  hasGuidelines: true,
  imageCount: 2,
};

const render = (brands: BrandSummary[] | null, value?: string) =>
  renderToStaticMarkup(
    <BrandDrill brands={brands} value={value} onBack={() => {}} onApply={async () => {}} />,
  );

describe("BrandDrill", () => {
  it("offers None plus every brand, marking the applied one", () => {
    const html = render([ACME], "ws:acme");
    expect(html).toContain(">None<");
    expect(html).toContain(">Acme<");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("BRAND.md");
    expect(html).toContain('title="Ink"');
    expect(html).not.toContain(NO_BRANDS_HINT);
  });

  it("explains how to add a brand when the workspace has none", () => {
    expect(render([])).toContain(NO_BRANDS_HINT);
  });

  it("flags a brand that is no longer in the workspace", () => {
    expect(render([ACME], "ws:gone")).toContain("no longer in your workspace");
  });
});
