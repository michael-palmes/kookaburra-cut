import {
  ACESFilmicToneMapping,
  BoxGeometry,
  HalfFloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  Scene,
  SRGBColorSpace,
  WebGLRenderTarget,
} from "three";
import { WebGLPrograms } from "three/src/renderers/webgl/WebGLPrograms.js";
import { describe, expect, it } from "vitest";
import { compareFragmentShader } from "./compareShader";
import { asDisplayTarget, encodesSrgbOnStore, isDisplayTarget } from "./displayTarget";
import { overlayFragmentShader } from "./overlayShader";
import {
  fragmentShader,
  fragmentShaderExt,
  fragmentShaderExt2,
  fragmentShaderExt3,
  fragmentShaderMask,
} from "./transitionShader";

// Stubs carry only what getParameters reads, so the three internals are typed loosely.
const Programs = WebGLPrograms as unknown as new (
  ...deps: unknown[]
) => { getParameters: (...args: unknown[]) => { toneMapping: number; outputColorSpace: string } };

const noLights = {
  sun: [],
  directional: [],
  point: [],
  spot: [],
  spotLightMap: [],
  rectArea: [],
  hemi: [],
  sunShadowMap: [],
  directionalShadowMap: [],
  pointShadowMap: [],
  spotShadowMap: [],
  numSpotLightShadowsWithMaps: 0,
  numLightProbes: 0,
};

function paramsFor(
  target: WebGLRenderTarget | null,
  toneMapped: boolean,
  outputColorSpace: string = SRGBColorSpace,
) {
  const renderer = {
    getRenderTarget: () => target,
    state: { buffers: { depth: { getReversed: () => false } } },
    toneMapping: ACESFilmicToneMapping,
    outputColorSpace,
    shadowMap: { enabled: false, type: 0 },
  };
  const programs = new Programs(
    renderer,
    { get: () => null },
    { has: () => false },
    { logarithmicDepthBuffer: false, precision: "highp", getMaxPrecision: (p: string) => p },
    {},
    { numPlanes: 0, numIntersection: 0 },
  );
  const material = new MeshBasicMaterial({ toneMapped });
  const mesh = new Mesh(new BoxGeometry(), material);
  return programs.getParameters(material, noLights, [], new Scene(), mesh, []);
}

describe("asDisplayTarget", () => {
  it("compiles the canvas's own program parameters", () => {
    const display = asDisplayTarget(new WebGLRenderTarget(4, 4), SRGBColorSpace);
    for (const toneMapped of [true, false]) {
      const canvas = paramsFor(null, toneMapped);
      const flagged = paramsFor(display, toneMapped);
      expect(flagged.toneMapping).toBe(canvas.toneMapping);
      expect(flagged.outputColorSpace).toBe(canvas.outputColorSpace);
    }
    expect(paramsFor(display, true).toneMapping).toBe(ACESFilmicToneMapping);
    expect(paramsFor(display, true).outputColorSpace).toBe(SRGBColorSpace);
  });

  it("encodes to the renderer's output colour space it is given", () => {
    const display = asDisplayTarget(new WebGLRenderTarget(4, 4), LinearSRGBColorSpace);
    const canvas = paramsFor(null, true, LinearSRGBColorSpace);
    expect(paramsFor(display, true, LinearSRGBColorSpace).outputColorSpace).toBe(
      canvas.outputColorSpace,
    );
  });

  it("leaves plain targets un-tone-mapped (the three gate this works around)", () => {
    const plain = new WebGLRenderTarget(4, 4);
    plain.texture.colorSpace = SRGBColorSpace;
    expect(paramsFor(plain, true).toneMapping).toBe(NoToneMapping);
  });

  it("stores the display bytes raw", () => {
    const display = asDisplayTarget(new WebGLRenderTarget(4, 4), SRGBColorSpace);
    expect(display.texture.internalFormat).toBe("RGBA8");
    expect(isDisplayTarget(display)).toBe(true);
    expect(encodesSrgbOnStore(display)).toBe(false);
    const legacy = new WebGLRenderTarget(4, 4);
    legacy.texture.colorSpace = SRGBColorSpace;
    expect(isDisplayTarget(legacy)).toBe(false);
    expect(encodesSrgbOnStore(legacy)).toBe(true);
    const hdr = new WebGLRenderTarget(4, 4, { type: HalfFloatType });
    hdr.texture.colorSpace = LinearSRGBColorSpace;
    expect(encodesSrgbOnStore(hdr)).toBe(false);
    expect(encodesSrgbOnStore(null)).toBe(false);
  });
});

// A future generation copying the old hardware-sRGB sampler would re-encode raw display bytes (the washed-out double encode).
describe("SDR composites over display targets", () => {
  const sdr = [
    ["legacy", fragmentShader],
    ["ext", fragmentShaderExt],
    ["ext2", fragmentShaderExt2],
    ["ext3", fragmentShaderExt3],
    ["mask", fragmentShaderMask],
    ["compare", compareFragmentShader],
  ] as const;

  it.each(sdr)("%s samples its targets raw", (_name, src) => {
    expect(src).not.toMatch(/linearToSrgb\(\s*texture/);
    expect(src).toMatch(/return texture2?D?\(t, clamp\(uv/);
  });

  it("overlay reads the scene target raw and still re-encodes its sRGB panel upload", () => {
    expect(overlayFragmentShader).toContain("vec3 sceneSrgb = texture2D(sceneTex,");
    expect(overlayFragmentShader).toContain("return sampleDisplay(panelTex,");
  });
});
