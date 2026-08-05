import { Effect, EffectAttribute } from "postprocessing";
import { Uniform, Vector2 } from "three";

/** Screen-space smear serving two dof modes: radial ("Burst") streaks toward an animatable centre, and a directional ("Swipe") smear along an angle. One effect covers both because modes are exclusive per scene and EffectPass allows a single convolution effect. Deterministic: a fixed tap count, a spatial hash jitter that is a pure function of the pixel coordinate (the grain rule, no time or seed), CPU-written uniforms (trig included). See docs/determinism.md. */

/** Fixed sample count along the smear. EXPORT CONTRACT (deliberate-rebase constant). */
export const SMEAR_TAPS = 32;

// inputBuffer is declared by the merged EffectPass shader (the convolution contract); resolution is the pass's built-in. The jitter offsets each pixel's taps along the span, trading the ghost-copy banding of a fixed comb for smooth noise.
const fragmentShader = /* glsl */ `
  uniform float uAmount;
  uniform float uRadial;
  uniform vec2 uCenter;
  uniform vec2 uCosSin;

  float smearHash(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    if (uAmount <= 0.0) {
      outputColor = inputColor;
      return;
    }
    vec2 dirSpan = vec2(uCosSin.x * resolution.y / resolution.x, uCosSin.y) * uAmount;
    vec2 raySpan = (uCenter - uv) * uAmount;
    vec2 span = mix(dirSpan, raySpan, uRadial);
    float j = smearHash(uv * resolution);
    vec4 acc = vec4(0.0);
    for (int i = 0; i < SMEAR_TAPS; ++i) {
      float t = (float(i) + j) / float(SMEAR_TAPS) - (1.0 - uRadial) * 0.5;
      acc += texture2D(inputBuffer, uv + span * t);
    }
    outputColor = vec4(acc.rgb / float(SMEAR_TAPS), inputColor.a);
  }
`;

export class SmearEffect extends Effect {
  private readonly amountUniform: Uniform;
  private readonly radialUniform: Uniform;
  private readonly centerUniform: Uniform;
  private readonly cosSinUniform: Uniform;

  constructor() {
    const amountUniform = new Uniform(0);
    const radialUniform = new Uniform(0);
    const centerUniform = new Uniform(new Vector2(0.5, 0.5));
    const cosSinUniform = new Uniform(new Vector2(1, 0));
    super("SmearEffect", fragmentShader, {
      attributes: EffectAttribute.CONVOLUTION,
      defines: new Map([["SMEAR_TAPS", String(SMEAR_TAPS)]]),
      uniforms: new Map<string, Uniform>([
        ["uAmount", amountUniform],
        ["uRadial", radialUniform],
        ["uCenter", centerUniform],
        ["uCosSin", cosSinUniform],
      ]),
    });
    this.amountUniform = amountUniform;
    this.radialUniform = radialUniform;
    this.centerUniform = centerUniform;
    this.cosSinUniform = cosSinUniform;
  }

  /** Zoom streaks toward a centre offset -1..1 each axis; `amount` is the premultiplied span fraction. */
  setRadial(amount: number, centerX: number, centerY: number): void {
    this.radialUniform.value = 1;
    this.amountUniform.value = amount;
    (this.centerUniform.value as Vector2).set(0.5 + centerX * 0.5, 0.5 + centerY * 0.5);
  }

  /** Symmetric smear along `angleDeg` (screen-true; the shader aspect-corrects); `amount` is the smear length as a fraction of frame height. */
  setDirectional(amount: number, angleDeg: number): void {
    const rad = (angleDeg * Math.PI) / 180;
    this.radialUniform.value = 0;
    this.amountUniform.value = amount;
    (this.cosSinUniform.value as Vector2).set(Math.cos(rad), Math.sin(rad));
  }

  setInactive(): void {
    this.amountUniform.value = 0;
  }
}
