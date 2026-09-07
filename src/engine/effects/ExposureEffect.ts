import { BlendFunction, Effect } from "postprocessing";
import { Uniform } from "three";

/** Exposure for the composer path (v9 · PR 8): a plain pre-tone-map multiply, sitting immediately BEFORE the ToneMappingEffect in the chain, mirroring where `gl.toneMappingExposure` applies in three's own pipeline (the r3f path). Applying it after the curve looks similar at 1.0 and completely wrong at 0.5 and 2.0. A pure per-pixel scale: deterministic by construction. */
const fragmentShader = /* glsl */ `
  uniform float uExposure;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    outputColor = vec4(inputColor.rgb * uExposure, inputColor.a);
  }
`;

export class ExposureEffect extends Effect {
  private readonly exposureUniform: Uniform;

  constructor() {
    const exposureUniform = new Uniform(1);
    super("ExposureEffect", fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([["uExposure", exposureUniform]]),
    });
    this.exposureUniform = exposureUniform;
  }

  set exposure(value: number) {
    this.exposureUniform.value = value;
  }
}
