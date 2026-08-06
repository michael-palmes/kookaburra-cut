import { describe, expect, it } from "vitest";
import { collectThemeFontRefs } from "./fonts";
import { builtinThemes } from "./registry";
import type { Theme } from "./tokens";

/** The preload set the export preamble builds: a face that is not in it is first typeset mid-run, which claims SDF atlas cells late (docs/determinism.md, "Fonts"). */

const base = Object.values(builtinThemes)[0];
const withTypography = (typography: Partial<Theme["typography"]>): Theme => ({
  ...base,
  typography: { ...base.typography, ...typography },
});

describe("collectThemeFontRefs", () => {
  it("takes the headline and body of every theme, de-duplicated", () => {
    const a = withTypography({
      headline: { family: "Avenir Next", weight: 600 },
      body: { family: "Georgia", weight: 400 },
    });
    const b = withTypography({
      headline: { family: "Avenir Next", weight: 600 },
      body: { family: "Avenir Next", weight: 600 },
    });
    expect(collectThemeFontRefs([a, b, undefined])).toEqual([
      { family: "Avenir Next", weight: 600 },
      { family: "Georgia", weight: 400 },
    ]);
  });

  it("carries the project's chart face into the preload set", () => {
    const theme = withTypography({
      headline: { family: "Inter", weight: 600 },
      body: { family: "Inter", weight: 400 },
      chart: { family: "IBM Plex Mono", weight: 500 },
    });
    expect(collectThemeFontRefs([theme])).toContainEqual({
      family: "IBM Plex Mono",
      weight: 500,
    });
  });

  it("collects nothing extra when no theme names a chart face", () => {
    const theme = withTypography({
      headline: { family: "Inter", weight: 600 },
      body: { family: "Inter", weight: 400 },
    });
    expect(collectThemeFontRefs([theme])).toEqual([
      { family: "Inter", weight: 600 },
      { family: "Inter", weight: 400 },
    ]);
  });
});
