import { BlendFunction, Effect } from "postprocessing";
import { Uniform } from "three";

/** Film grain whose only inputs are a CPU-supplied per-frame seed and the pixel coordinate, never the composer's injected `time` uniform or `Math.random`, so it's byte-identical run to run; this is why the stock `NoiseEffect` (which reads the accumulating `time` uniform) is forbidden by the effects allow-list. See docs/determinism.md. */
const fragmentShader = /* glsl */ `
  uniform float uSeed;
  uniform float uIntensity;

  // Cheap 2D hash → [0,1). Pure function of its argument.
  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    // resolution is provided by the postprocessing Effect base; uSeed offsets the hash per frame.
    float g = hash21(uv * resolution + uSeed) - 0.5;
    outputColor = vec4(inputColor.rgb + g * uIntensity, inputColor.a);
  }
`;

export class DeterministicGrainEffect extends Effect {
  private readonly seedUniform: Uniform;
  private readonly intensityUniform: Uniform;

  constructor() {
    const seedUniform = new Uniform(0);
    const intensityUniform = new Uniform(0);
    super("DeterministicGrainEffect", fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["uSeed", seedUniform],
        ["uIntensity", intensityUniform],
      ]),
    });
    this.seedUniform = seedUniform;
    this.intensityUniform = intensityUniform;
  }

  /** The per-frame seed, set to the integer frame index (grainSeed) before each render. */
  set seed(value: number) {
    this.seedUniform.value = value;
  }

  /** Grain strength; 0 = no grain. */
  set intensity(value: number) {
    this.intensityUniform.value = value;
  }
}
