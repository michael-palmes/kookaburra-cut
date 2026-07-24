import { describe, expect, it } from "vitest";
import { SHADER_BACKGROUNDS } from "./index";
import { FRAGMENT_MAIN_MARKER, FRAGMENT_OUT_MARKER, wrapDisplayDomainFragment } from "./wrap";

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("display-domain fragment wrapper", () => {
  it("finds exactly one of each rewrite marker in every vendored fragment", () => {
    for (const [id, def] of Object.entries(SHADER_BACKGROUNDS)) {
      expect(count(def.fragment, FRAGMENT_OUT_MARKER), id).toBe(1);
      expect(count(def.fragment, FRAGMENT_MAIN_MARKER), id).toBe(1);
    }
  });

  it("reroutes main() and declares the engine-owned output and uniform", () => {
    for (const [id, def] of Object.entries(SHADER_BACKGROUNDS)) {
      const wrapped = wrapDisplayDomainFragment(def.fragment);
      expect(count(wrapped, "void main() {"), id).toBe(1);
      expect(count(wrapped, "void kkSceneMain() {"), id).toBe(1);
      expect(count(wrapped, "out vec4 kkFragColor;"), id).toBe(1);
      expect(count(wrapped, "uniform float u_linearOut;"), id).toBe(1);
      expect(wrapped.includes(FRAGMENT_OUT_MARKER), id).toBe(false);
    }
  });
});
