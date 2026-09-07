import { Effect, GaussianBlurPass } from "postprocessing";
import { type TextureDataType, Uniform, type WebGLRenderer, WebGLRenderTarget } from "three";

/** Soft-focus ("Dream") diffusion: a fixed-kernel Gaussian blur of the frame, mixed back over the sharp image (`amount`) with a screen-blended highlight lift (`glow`), the Pro-Mist filter look. Deterministic by construction: fixed kernel and iteration count, per-frame CPU-written uniforms, no time reads; when inactive the blur pre-pass is skipped and the guarded fragment never reads the stale target. See docs/determinism.md. */

/** Gaussian kernel size for the diffusion pre-pass. EXPORT CONTRACT (deliberate-rebase constant). */
export const SOFT_FOCUS_KERNEL = 35;

const fragmentShader = /* glsl */ `
  #ifdef FRAMEBUFFER_PRECISION_HIGH
    uniform mediump sampler2D softBuffer;
  #else
    uniform lowp sampler2D softBuffer;
  #endif
  uniform float uAmount;
  uniform float uGlow;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    if (uAmount <= 0.0 && uGlow <= 0.0) {
      outputColor = inputColor;
      return;
    }
    vec4 soft = texture2D(softBuffer, uv);
    vec3 diffused = mix(inputColor.rgb, soft.rgb, uAmount);
    vec3 lift = clamp(soft.rgb, 0.0, 1.0) * uGlow;
    vec3 screened = 1.0 - (1.0 - clamp(diffused, 0.0, 1.0)) * (1.0 - lift);
    // max() keeps HDR peaks: screen() is an LDR lift and must never darken a bright source before bloom.
    outputColor = vec4(max(diffused, screened), inputColor.a);
  }
`;

export class SoftFocusEffect extends Effect {
  private readonly blurPass: GaussianBlurPass;
  private readonly renderTargetSoft: WebGLRenderTarget;
  private readonly amountUniform: Uniform;
  private readonly glowUniform: Uniform;
  private active = false;

  constructor(resolutionScale: number) {
    const amountUniform = new Uniform(0);
    const glowUniform = new Uniform(0);
    const renderTargetSoft = new WebGLRenderTarget(1, 1, { depthBuffer: false });
    renderTargetSoft.texture.name = "SoftFocus.Blurred";
    super("SoftFocusEffect", fragmentShader, {
      uniforms: new Map<string, Uniform>([
        ["softBuffer", new Uniform(renderTargetSoft.texture)],
        ["uAmount", amountUniform],
        ["uGlow", glowUniform],
      ]),
    });
    this.blurPass = new GaussianBlurPass({ kernelSize: SOFT_FOCUS_KERNEL, resolutionScale });
    this.renderTargetSoft = renderTargetSoft;
    this.amountUniform = amountUniform;
    this.glowUniform = glowUniform;
  }

  /** Per-frame params: `amount` is the diffusion mix 0..1, `glow` the halation lift 0..1; both 0 = pass-through. */
  setParams(amount: number, glow: number): void {
    this.amountUniform.value = amount;
    this.glowUniform.value = glow;
    this.active = amount > 0 || glow > 0;
  }

  override update(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    if (this.active) this.blurPass.render(renderer, inputBuffer, this.renderTargetSoft);
  }

  override setSize(width: number, height: number): void {
    this.blurPass.setSize(width, height);
    this.renderTargetSoft.setSize(width, height);
  }

  override initialize(renderer: WebGLRenderer, alpha: boolean, frameBufferType: number): void {
    this.blurPass.initialize(renderer, alpha, frameBufferType);
    if (frameBufferType !== undefined) {
      this.renderTargetSoft.texture.type = frameBufferType as TextureDataType;
    }
  }
}
