import { BackSide, FrontSide, type Vector2 } from "three";
import { describe, expect, it } from "vitest";
import { LOOK_GLSL_FRAGMENT, LOOK_GLSL_VERTEX, LOOK_VERTEX_SHADER } from "./glsl";
import {
  createLookMaterial,
  type LookMaterialSpec,
  lookColor,
  lookColorUniform,
  lookLuminance,
  lookMaterialProblem,
  syncLookFrame,
} from "./material";

const FRAGMENT = /* glsl */ `
uniform vec3 uInk;
varying vec3 vWorld;
void main() {
  gl_FragColor = vec4(uInk * stageFade(vWorld), 1.0);
  #include <colorspace_fragment>
}
`;
const spec = (over: Partial<LookMaterialSpec> = {}): LookMaterialSpec => ({
  key: "test-look/floor",
  fragmentShader: FRAGMENT,
  uniforms: { uInk: lookColorUniform("#3b5c7d") },
  ...over,
});

describe("createLookMaterial", () => {
  it("builds an unlit material with the kit prepended and a fixed cache key", () => {
    const m = createLookMaterial(spec());
    expect(m.toneMapped).toBe(false);
    expect(m.lights).toBe(false);
    expect(m.fog).toBe(false);
    expect(m.fragmentShader.startsWith(LOOK_GLSL_FRAGMENT)).toBe(true);
    expect(m.vertexShader).toBe(`${LOOK_GLSL_VERTEX}\n${LOOK_VERTEX_SHADER}`);
    expect(m.customProgramCacheKey()).toBe("kk-look:test-look/floor");
    expect(m.name).toBe("kk-look:test-look/floor");
    expect(m.uniforms.uInk).toBeDefined();
    expect(m.uniforms.uPx.value).toBe(1);
    expect(m.side).toBe(FrontSide);
    expect(m.depthWrite).toBe(true);
  });

  it("drops depth writes for transparent parts and culls near faces for cutaways", () => {
    const m = createLookMaterial(spec({ transparent: true, cutaway: true }));
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.side).toBe(BackSide);
  });

  it("antialiases opaque cut-outs through MSAA coverage only when asked", () => {
    expect(createLookMaterial(spec()).alphaToCoverage).toBe(false);
    const m = createLookMaterial(spec({ alphaToCoverage: true }));
    expect(m.alphaToCoverage).toBe(true);
    expect(m.transparent).toBe(false);
    expect(m.depthWrite).toBe(true);
  });

  it("throws with the key when a rule is broken", () => {
    expect(() => createLookMaterial(spec({ fragmentShader: "void main() {}" }))).toThrow(
      /test-look\/floor.*colorspace_fragment/,
    );
  });
});

describe("lookMaterialProblem", () => {
  const broken: [string, Partial<LookMaterialSpec>, RegExp][] = [
    ["bad key", { key: "Floor" }, /key/],
    [
      "float hash",
      { fragmentShader: `${FRAGMENT}\nfloat h(float x) { return fract(sin(x)); }` },
      /fract/,
    ],
    [
      "vertex derivative",
      { vertexShader: "void main() { float w = fwidth(1.0); }" },
      /fragment-only/,
    ],
    [
      "gl_FragCoord",
      { fragmentShader: FRAGMENT.replace("vWorld)", "gl_FragCoord.xyz)") },
      /gl_FragCoord/,
    ],
    ["version line", { fragmentShader: `#version 300 es\n${FRAGMENT}` }, /#version/],
    [
      "uPx redeclared",
      { fragmentShader: `uniform float uTime, uPx;\n${FRAGMENT}` },
      /declared by the kit/,
    ],
    ["uPx uniform passed", { uniforms: { uPx: { value: 2 } } }, /engine-owned/],
    [
      "transparent part without depth test",
      { transparent: true, depthTest: false },
      /paints over devices/,
    ],
  ];
  it.each(broken)("rejects a %s", (_name, over, message) => {
    expect(lookMaterialProblem(spec(over))).toMatch(message);
  });

  it("accepts a sound spec", () => {
    expect(lookMaterialProblem(spec())).toBeNull();
  });
});

describe("syncLookFrame", () => {
  it("pins resolution and uPx to the export format, 1080p = 1", () => {
    const m = createLookMaterial(spec());
    syncLookFrame(m, 3840, 2160);
    expect((m.uniforms.uResolution.value as Vector2).toArray()).toEqual([3840, 2160]);
    expect(m.uniforms.uPx.value).toBe(2);
    syncLookFrame(m, 2160, 3840);
    expect(m.uniforms.uPx.value).toBeCloseTo(3840 / 1080, 10);
  });
});

describe("look colours", () => {
  it("hold linear working-space values that round-trip to the same hex", () => {
    const c = lookColor("#3b5c7d");
    expect(c.r).toBeLessThan(59 / 255);
    expect(c.getHexString()).toBe("3b5c7d");
    const u = lookColorUniform("#3b5c7d");
    u.value.set("#0d1218");
    expect(u.value.getHexString()).toBe("0d1218");
  });

  it("measure relative luminance from the hex", () => {
    expect(lookLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(lookLuminance("#000000")).toBe(0);
    expect(lookLuminance("#808080")).toBeCloseTo(0.2158605, 6);
    expect(lookLuminance("#0e1011")).toBeLessThan(lookLuminance("#2a2f2d"));
  });
});
