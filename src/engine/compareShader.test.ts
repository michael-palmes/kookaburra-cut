import { describe, expect, it } from "vitest";
import { COMPARE_GRIP_CATALOG } from "./compareCatalog";
import { compareFragmentShader, compareFragmentShaderHdr } from "./compareShader";
import { COMPARE_GRIP_ID } from "./sceneCompare";

/** Source pins, not maths: the grip dispatch is export path, and style 0 must compile from the SAME expressions as the pre-style shader (the byte-identical null proof, docs/determinism.md). If a change here is deliberate, re-verify ws:compare-spike before touching this file. */

const CHEVRONS_BRANCH = `        float ring = 1.0 - smoothstep(w, w * 2.2, abs(length(l) - R));
        float chL = min(
          sdSeg(l, vec2(-R * 0.25, R * 0.3), vec2(-R * 0.55, 0.0)),
          sdSeg(l, vec2(-R * 0.25, -R * 0.3), vec2(-R * 0.55, 0.0)));
        float chR = min(
          sdSeg(l, vec2(R * 0.25, R * 0.3), vec2(R * 0.55, 0.0)),
          sdSeg(l, vec2(R * 0.25, -R * 0.3), vec2(R * 0.55, 0.0)));
        float chev = 1.0 - smoothstep(w * 0.9, w * 2.0, min(chL, chR));
        chrome = max(chrome, max(ring, chev));`;

const variants = [
  ["sdr", compareFragmentShader],
  ["hdr", compareFragmentShaderHdr],
] as const;

describe("compare fragment shader", () => {
  it.each(variants)("%s keeps the legacy chevrons expressions verbatim", (_name, src) => {
    expect(src).toContain(CHEVRONS_BRANCH);
  });

  it.each(variants)("%s declares the grip style uniform and every branch", (_name, src) => {
    expect(src).toContain("uniform int gripStyle;");
    for (const entry of COMPARE_GRIP_CATALOG) {
      const id = COMPARE_GRIP_ID[entry.id];
      // Style 0 is the else fallback, so only the non-default ids carry an explicit test.
      if (id > 0) expect(src).toContain(`gripStyle == ${id}`);
    }
    expect(src).not.toContain("gripStyle == 0");
    expect(src).not.toContain(`gripStyle == ${COMPARE_GRIP_CATALOG.length}`);
  });

  it("draws every grip inside the one linear-mask guard, after the line", () => {
    const guard = compareFragmentShader.indexOf("if (gripSize > 0.0 && maskType == 0) {");
    expect(guard).toBeGreaterThan(compareFragmentShader.indexOf("float chrome = 0.0;"));
    expect(compareFragmentShader.indexOf("gripStyle == 1")).toBeGreaterThan(guard);
    expect(compareFragmentShader.indexOf("outC = mix(outC, lineColor, chrome);")).toBeGreaterThan(
      compareFragmentShader.indexOf("gripStyle == 3"),
    );
  });
});
