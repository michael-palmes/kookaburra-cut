/** Lens depth of field (dof mode "lens"): a thin-lens CoC from true scene depth, gathered on a Vogel disc at half resolution and composited at full resolution so the focus band stays exactly as rendered. Deterministic by construction: fixed tap pattern and counts, a screen-fixed per-pixel rotation, CPU-written uniforms, no time reads; when inactive the passes are skipped and the composite never reads their stale targets. Its constants are export-contract constants (lensDof.ts, docs/determinism.md). */
import { Effect, EffectAttribute, ShaderPass } from "postprocessing";
import {
  BasicDepthPacking,
  type Camera,
  type DepthPackingStrategies,
  HalfFloatType,
  NearestFilter,
  NoBlending,
  type PerspectiveCamera,
  RedFormat,
  RGBAFormat,
  ShaderMaterial,
  type Texture,
  Uniform,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { LensParams } from "./lensDof";
import { LENS_COC_MAX, LENS_RESOLUTION_SCALE, LENS_TAPS, lensUniforms } from "./lensDof";
import {
  lensCompositeShader,
  lensDilateShader,
  lensGatherShader,
  lensPrefilterShader,
  lensTentShader,
  lensTileShader,
  lensVertexShader,
} from "./lensDofShaders";

function target(format: typeof RGBAFormat | typeof RedFormat, name: string): WebGLRenderTarget {
  const t = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  t.texture.name = name;
  return t;
}

function material(
  fragmentShader: string,
  uniforms: Record<string, Uniform>,
  defines: Record<string, string>,
): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    defines,
    vertexShader: lensVertexShader,
    fragmentShader,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

export class LensDofEffect extends Effect {
  private readonly prefilterTarget = target(RGBAFormat, "LensDof.Prefilter");
  private readonly tileTarget = target(RedFormat, "LensDof.Tiles");
  private readonly dilateTarget = target(RedFormat, "LensDof.NearMax");
  private readonly gatherTarget = target(RGBAFormat, "LensDof.Gather");
  private readonly tentTarget = target(RGBAFormat, "LensDof.Blur");
  private readonly prefilterPass: ShaderPass;
  private readonly tilePass: ShaderPass;
  private readonly dilatePass: ShaderPass;
  private readonly gatherPass: ShaderPass;
  private readonly tentPass: ShaderPass;
  private camera: Camera | null = null;
  private params: (LensParams & { squeeze: number }) | null = null;
  private fullHeight = 1;

  constructor(display = false) {
    const defines: Record<string, string> = display ? { LENS_DISPLAY: "1" } : {};
    const halfSize = new Uniform(new Vector2(1, 1));
    super("LensDofEffect", lensCompositeShader, {
      attributes: EffectAttribute.DEPTH,
      defines: new Map(Object.entries(defines)),
      uniforms: new Map<string, Uniform>([
        ["lensBlurBuffer", new Uniform(null)],
        ["lensCocBuffer", new Uniform(null)],
        ["lensHalfSize", halfSize],
        ["lensFocus", new Uniform(1)],
        ["lensCocInf", new Uniform(0)],
        ["lensCocMax", new Uniform(0)],
        ["lensHalfScale", new Uniform(LENS_RESOLUTION_SCALE)],
        ["lensActive", new Uniform(false)],
      ]),
    });
    const tileSize = new Uniform(1);
    const cocMax = new Uniform(0);
    this.prefilterPass = new ShaderPass(
      material(
        lensPrefilterShader,
        {
          inputBuffer: new Uniform(null),
          depthBuffer: new Uniform(null),
          fullTexel: new Uniform(new Vector2(1, 1)),
          cameraNear: new Uniform(0.1),
          cameraFar: new Uniform(100),
          focus: new Uniform(1),
          cocInf: new Uniform(0),
          cocMax,
        },
        { ...defines, DEPTH_PACKING: `${BasicDepthPacking}` },
      ),
    );
    this.tilePass = new ShaderPass(
      material(
        lensTileShader,
        {
          cocBuffer: new Uniform(this.prefilterTarget.texture),
          halfSize,
          tileSize,
        },
        {},
      ),
    );
    this.dilatePass = new ShaderPass(
      material(
        lensDilateShader,
        {
          tileBuffer: new Uniform(this.tileTarget.texture),
          tileCount: new Uniform(new Vector2(1, 1)),
        },
        {},
      ),
    );
    this.gatherPass = new ShaderPass(
      material(
        lensGatherShader,
        {
          cocBuffer: new Uniform(this.prefilterTarget.texture),
          tileBuffer: new Uniform(this.dilateTarget.texture),
          halfSize,
          tileSize,
          cocMax,
          squeezeX: new Uniform(1),
        },
        { LENS_TAPS: `${LENS_TAPS}` },
      ),
    );
    this.tentPass = new ShaderPass(
      material(
        lensTentShader,
        {
          gatherBuffer: new Uniform(this.gatherTarget.texture),
          cocBuffer: new Uniform(this.prefilterTarget.texture),
          halfSize,
        },
        {},
      ),
    );
    this.setUniform("lensBlurBuffer", this.tentTarget.texture);
    this.setUniform("lensCocBuffer", this.prefilterTarget.texture);
  }

  private setUniform(name: string, value: unknown): void {
    const u = this.uniforms.get(name);
    if (u) u.value = value;
  }

  override set mainCamera(value: Camera) {
    this.camera = value;
  }

  /** The frame's lens, or null to pass every pixel through untouched. */
  setLens(params: (LensParams & { squeeze: number }) | null): void {
    this.params = params && params.blur > 0 ? params : null;
  }

  override setDepthTexture(
    depthTexture: Texture,
    depthPacking: DepthPackingStrategies = BasicDepthPacking,
  ): void {
    const mat = this.prefilterPass.fullscreenMaterial as ShaderMaterial;
    mat.uniforms.depthBuffer.value = depthTexture;
    mat.defines.DEPTH_PACKING = `${depthPacking}`;
    mat.needsUpdate = true;
  }

  override update(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    const cam = this.camera as PerspectiveCamera | null;
    const p = this.params;
    const active = !!p && !!cam?.isPerspectiveCamera;
    this.setUniform("lensActive", active);
    if (!active || !p || !cam) return;
    const u = lensUniforms(p, cam.projectionMatrix.elements[5]);
    const halfHeight = this.prefilterTarget.height;
    const pre = (this.prefilterPass.fullscreenMaterial as ShaderMaterial).uniforms;
    pre.inputBuffer.value = inputBuffer.texture;
    pre.cameraNear.value = cam.near;
    pre.cameraFar.value = cam.far;
    pre.focus.value = u.focus;
    pre.cocInf.value = u.cocInf * halfHeight;
    pre.cocMax.value = LENS_COC_MAX * halfHeight;
    (this.gatherPass.fullscreenMaterial as ShaderMaterial).uniforms.squeezeX.value =
      1 / Math.max(1, p.squeeze);
    this.setUniform("lensFocus", u.focus);
    this.setUniform("lensCocInf", u.cocInf * this.fullHeight);
    this.setUniform("lensCocMax", LENS_COC_MAX * this.fullHeight);
    this.prefilterPass.render(renderer, null, this.prefilterTarget);
    this.tilePass.render(renderer, null, this.tileTarget);
    this.dilatePass.render(renderer, null, this.dilateTarget);
    this.gatherPass.render(renderer, null, this.gatherTarget);
    this.tentPass.render(renderer, null, this.tentTarget);
  }

  override setSize(width: number, height: number): void {
    const hw = Math.max(1, Math.round(width * LENS_RESOLUTION_SCALE));
    const hh = Math.max(1, Math.round(height * LENS_RESOLUTION_SCALE));
    // One tile spans the largest disc, so a 3x3 dilation reaches every pixel a near disc can cover.
    const tile = Math.max(1, Math.ceil(LENS_COC_MAX * hh));
    const tw = Math.ceil(hw / tile);
    const th = Math.ceil(hh / tile);
    this.fullHeight = height;
    this.setUniform("lensHalfScale", hh / height);
    this.prefilterTarget.setSize(hw, hh);
    this.gatherTarget.setSize(hw, hh);
    this.tentTarget.setSize(hw, hh);
    this.tileTarget.setSize(tw, th);
    this.dilateTarget.setSize(tw, th);
    const pre = (this.prefilterPass.fullscreenMaterial as ShaderMaterial).uniforms;
    (pre.fullTexel.value as Vector2).set(1 / width, 1 / height);
    const tileU = (this.tilePass.fullscreenMaterial as ShaderMaterial).uniforms;
    (tileU.halfSize.value as Vector2).set(hw, hh);
    tileU.tileSize.value = tile;
    (
      (this.dilatePass.fullscreenMaterial as ShaderMaterial).uniforms.tileCount.value as Vector2
    ).set(tw, th);
  }
}
