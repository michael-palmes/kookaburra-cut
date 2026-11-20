import { BlendFunction, Effect } from "postprocessing";
import {
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  Color,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Texture,
  type TextureDataType,
  Uniform,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { LensParams } from "../theme/tokens";

/** Lens response for hot highlights (research prototype): an energy-conserving mip-chain bloom (mix, never add, so only genuinely hot pixels glow), a warm halation around them, and optional star or anamorphic glare. Scene-referred: it runs on the linear HDR buffer before exposure and the tone map. Deterministic by construction: fixed taps and level counts, every uniform CPU-written per frame, no history. */

/** Mip levels below the half-resolution prefilter. EXPORT CONTRACT once shipped. */
export const LENS_LEVELS = 7;
/** Taps per side on each glare pass, and the pass count per axis. EXPORT CONTRACT once shipped. */
export const LENS_GLARE_TAPS = 3;
export const LENS_GLARE_PASSES = 3;

export type { LensParams };

/** Every field a frame's params omit resolves here, never from an earlier frame. */
export const LENS_DEFAULTS: Required<LensParams> = {
  intensity: 0,
  bloom: 0.05,
  bloomRadius: 0.8,
  karis: 1,
  halation: 0,
  halationColor: "#ff6a2a",
  halationThreshold: 1,
  glare: 0,
  glarePoints: 4,
  glareAngleDeg: 0,
  glareThreshold: 4,
  glareFalloff: 0.86,
};

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// 13-tap downsample (Jimenez, Next Generation Post Processing in Call of Duty: Advanced Warfare); Karis-weighted boxes on the first level.
const DOWNSAMPLE = /* glsl */ `
uniform sampler2D src;
uniform vec2 texel;
uniform float karis;
varying vec2 vUv;
float kw(vec3 c) { return mix(1.0, 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))), karis); }
vec3 t(vec2 o) { return texture2D(src, vUv + o * texel).rgb; }
void main() {
  vec3 a = t(vec2(-2.0, 2.0)), b = t(vec2(0.0, 2.0)), c = t(vec2(2.0, 2.0));
  vec3 d = t(vec2(-2.0, 0.0)), e = t(vec2(0.0, 0.0)), f = t(vec2(2.0, 0.0));
  vec3 g = t(vec2(-2.0, -2.0)), h = t(vec2(0.0, -2.0)), i = t(vec2(2.0, -2.0));
  vec3 j = t(vec2(-1.0, 1.0)), k = t(vec2(1.0, 1.0)), l = t(vec2(-1.0, -1.0)), m = t(vec2(1.0, -1.0));
  vec3 b0 = (j + k + l + m) * 0.25;
  vec3 b1 = (a + b + d + e) * 0.25;
  vec3 b2 = (b + c + e + f) * 0.25;
  vec3 b3 = (d + e + g + h) * 0.25;
  vec3 b4 = (e + f + h + i) * 0.25;
  float w0 = 0.5 * kw(b0), w1 = 0.125 * kw(b1), w2 = 0.125 * kw(b2), w3 = 0.125 * kw(b3), w4 = 0.125 * kw(b4);
  gl_FragColor = vec4((b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + b4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
}
`;

// 3x3 tent upsample of the coarser level, mixed over this level's downsample: a normalised sum, so the chain conserves energy.
const UPSAMPLE = /* glsl */ `
uniform sampler2D coarse;
uniform sampler2D base;
uniform vec2 texel;
uniform float radius;
varying vec2 vUv;
vec3 t(vec2 o) { return texture2D(coarse, vUv + o * texel).rgb; }
void main() {
  vec3 c = t(vec2(0.0)) * 4.0;
  c += (t(vec2(-1.0, 0.0)) + t(vec2(1.0, 0.0)) + t(vec2(0.0, -1.0)) + t(vec2(0.0, 1.0))) * 2.0;
  c += t(vec2(-1.0, -1.0)) + t(vec2(1.0, -1.0)) + t(vec2(-1.0, 1.0)) + t(vec2(1.0, 1.0));
  gl_FragColor = vec4(mix(texture2D(base, vUv).rgb, c / 16.0, radius), 1.0);
}
`;

// Kawase light streak: symmetric taps along one axis, the step growing by (2 taps + 1) each pass; pass 0 bright-passes its source.
const STREAK = /* glsl */ `
uniform sampler2D src;
uniform vec2 dir;
uniform float stepSize;
uniform float falloff;
uniform float threshold;
uniform float first;
varying vec2 vUv;
vec3 bright(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return c * (max(l - threshold, 0.0) / max(l, 1e-4));
}
vec3 s(vec2 uv) {
  vec3 c = texture2D(src, uv).rgb;
  return first > 0.5 ? bright(c) : c;
}
void main() {
  vec3 sum = s(vUv);
  float total = 1.0;
  for (int k = 1; k <= ${LENS_GLARE_TAPS}; k++) {
    float w = pow(falloff, float(k) * stepSize);
    sum += w * (s(vUv + dir * float(k) * stepSize) + s(vUv - dir * float(k) * stepSize));
    total += 2.0 * w;
  }
  gl_FragColor = vec4(sum / total, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D lensBloom;
uniform sampler2D lensHaloA;
uniform sampler2D lensHaloB;
uniform sampler2D lensGlare0;
uniform sampler2D lensGlare1;
uniform sampler2D lensGlare2;
uniform float uBloom;
uniform float uHalation;
uniform vec3 uHalationTint;
uniform float uHalationThreshold;
uniform vec3 uGlare;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  if (uBloom > 0.0) c = mix(c, texture2D(lensBloom, uv).rgb, uBloom);
  if (uHalation > 0.0) {
    vec3 h = texture2D(lensHaloA, uv).rgb * 0.6 + texture2D(lensHaloB, uv).rgb * 0.4;
    float hl = dot(h, vec3(0.2126, 0.7152, 0.0722));
    c += uHalation * uHalationTint * max(hl - uHalationThreshold, 0.0);
  }
  if (uGlare.x > 0.0) c += uGlare.x * texture2D(lensGlare0, uv).rgb;
  if (uGlare.y > 0.0) c += uGlare.y * texture2D(lensGlare1, uv).rgb;
  if (uGlare.z > 0.0) c += uGlare.z * texture2D(lensGlare2, uv).rgb;
  outputColor = vec4(c, inputColor.a);
}
`;

function target(): WebGLRenderTarget {
  const t = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
  });
  t.texture.wrapS = ClampToEdgeWrapping;
  t.texture.wrapT = ClampToEdgeWrapping;
  return t;
}

function material(fragmentShader: string, uniforms: Record<string, Uniform>): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader,
    uniforms,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

export class LensEffect extends Effect {
  private readonly down: WebGLRenderTarget[] = [];
  private readonly up: WebGLRenderTarget[] = [];
  private readonly glare: WebGLRenderTarget[][] = [];
  private readonly downMat: ShaderMaterial;
  private readonly upMat: ShaderMaterial;
  private readonly streakMat: ShaderMaterial;
  private readonly quad: Mesh;
  private readonly quadScene = new Scene();
  private readonly camera = new Camera();
  private readonly size = new Vector2(1, 1);
  private readonly uBloom: Uniform<number>;
  private readonly uHalation: Uniform<number>;
  private readonly uHalationTint: Uniform<Vector3>;
  private readonly uHalationThreshold: Uniform<number>;
  private readonly uGlare: Uniform<Vector3>;
  private params: Required<LensParams> = LENS_DEFAULTS;

  constructor() {
    const down: WebGLRenderTarget[] = [];
    const up: WebGLRenderTarget[] = [];
    for (let i = 0; i < LENS_LEVELS; i++) {
      down.push(target());
      up.push(target());
    }
    const glare = [0, 1, 2].map(() => [target(), target()]);
    const shared = {
      uBloom: new Uniform(0),
      uHalation: new Uniform(0),
      uHalationTint: new Uniform(new Vector3(1, 0.3, 0.1)),
      uHalationThreshold: new Uniform(1),
      uGlare: new Uniform(new Vector3()),
    };
    super("LensEffect", FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["lensBloom", new Uniform(up[0].texture)],
        ["lensHaloA", new Uniform(down[1].texture)],
        ["lensHaloB", new Uniform(down[2].texture)],
        ["lensGlare0", new Uniform(glare[0][0].texture)],
        ["lensGlare1", new Uniform(glare[1][0].texture)],
        ["lensGlare2", new Uniform(glare[2][0].texture)],
        ...Object.entries(shared),
      ]),
    });
    this.uBloom = shared.uBloom;
    this.uHalation = shared.uHalation;
    this.uHalationTint = shared.uHalationTint;
    this.uHalationThreshold = shared.uHalationThreshold;
    this.uGlare = shared.uGlare;
    this.down.push(...down);
    this.up.push(...up);
    this.glare.push(...glare);
    this.downMat = material(DOWNSAMPLE, {
      src: new Uniform(null),
      texel: new Uniform(new Vector2()),
      karis: new Uniform(1),
    });
    this.upMat = material(UPSAMPLE, {
      coarse: new Uniform(null),
      base: new Uniform(null),
      texel: new Uniform(new Vector2()),
      radius: new Uniform(0.8),
    });
    this.streakMat = material(STREAK, {
      src: new Uniform(null),
      dir: new Uniform(new Vector2()),
      stepSize: new Uniform(1),
      falloff: new Uniform(0.86),
      threshold: new Uniform(4),
      first: new Uniform(1),
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this.quad = new Mesh(geometry, this.downMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setParams(p: LensParams | undefined): void {
    // Always from the defaults: a field one scene omits must never inherit the previous frame's value.
    const next = { ...LENS_DEFAULTS, ...(p ?? { intensity: 0 }) };
    this.params = next;
    const master = Math.max(0, Math.min(1, next.intensity));
    this.uBloom.value = master * Math.max(0, Math.min(0.5, next.bloom));
    this.uHalation.value = master * Math.max(0, next.halation);
    const tint = new Color(next.halationColor);
    this.uHalationTint.value.set(tint.r, tint.g, tint.b);
    this.uHalationThreshold.value = next.halationThreshold;
    const glare = master * Math.max(0, next.glare);
    const axes = next.glarePoints <= 2 ? 1 : next.glarePoints <= 4 ? 2 : 3;
    this.uGlare.value.set(glare, axes >= 2 ? glare : 0, axes >= 3 ? glare : 0);
  }

  private draw(renderer: WebGLRenderer, mat: ShaderMaterial, out: WebGLRenderTarget): void {
    this.quad.material = mat;
    renderer.setRenderTarget(out);
    renderer.render(this.quadScene, this.camera);
  }

  override update(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    const p = this.params;
    const bloom = this.uBloom.value;
    const halation = this.uHalation.value;
    const glare = this.uGlare.value;
    if (bloom <= 0 && halation <= 0 && glare.x <= 0) return;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    const du = this.downMat.uniforms;
    let src: Texture = inputBuffer.texture;
    let w = this.size.x;
    let h = this.size.y;
    for (let i = 0; i < LENS_LEVELS; i++) {
      du.src.value = src;
      (du.texel.value as Vector2).set(1 / w, 1 / h);
      du.karis.value = i === 0 ? p.karis : 0;
      this.draw(renderer, this.downMat, this.down[i]);
      src = this.down[i].texture;
      w = this.down[i].width;
      h = this.down[i].height;
    }
    if (bloom > 0) {
      const uu = this.upMat.uniforms;
      uu.radius.value = Math.max(0, Math.min(1, p.bloomRadius));
      let coarse = this.down[LENS_LEVELS - 1];
      for (let i = LENS_LEVELS - 2; i >= 0; i--) {
        uu.coarse.value = coarse.texture;
        uu.base.value = this.down[i].texture;
        (uu.texel.value as Vector2).set(1 / coarse.width, 1 / coarse.height);
        this.draw(renderer, this.upMat, this.up[i]);
        coarse = this.up[i];
      }
    }
    if (glare.x > 0) {
      const su = this.streakMat.uniforms;
      const source = this.down[1];
      su.falloff.value = Math.max(0.5, Math.min(0.98, p.glareFalloff));
      su.threshold.value = p.glareThreshold;
      const axes = p.glarePoints <= 2 ? 1 : p.glarePoints <= 4 ? 2 : 3;
      for (let a = 0; a < axes; a++) {
        const angle = ((p.glareAngleDeg + (a * 180) / axes) * Math.PI) / 180;
        const [ping, pong] = this.glare[a];
        let read: WebGLRenderTarget = source;
        let write = ping;
        for (let pass = 0; pass < LENS_GLARE_PASSES; pass++) {
          su.src.value = read.texture;
          su.first.value = pass === 0 ? 1 : 0;
          su.stepSize.value = (2 * LENS_GLARE_TAPS + 1) ** pass;
          (su.dir.value as Vector2).set(
            Math.cos(angle) / source.width,
            Math.sin(angle) / source.height,
          );
          this.draw(renderer, this.streakMat, write);
          read = write;
          write = write === ping ? pong : ping;
        }
        // An odd pass count ends in ping, the texture the fragment samples.
      }
    }
    renderer.autoClear = prevAutoClear;
  }

  override setSize(width: number, height: number): void {
    this.size.set(width, height);
    let w = width;
    let h = height;
    for (let i = 0; i < LENS_LEVELS; i++) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      this.down[i].setSize(w, h);
      this.up[i].setSize(w, h);
    }
    for (const [ping, pong] of this.glare) {
      ping.setSize(this.down[1].width, this.down[1].height);
      pong.setSize(this.down[1].width, this.down[1].height);
    }
  }

  override initialize(_renderer: WebGLRenderer, _alpha: boolean, frameBufferType: number): void {
    if (frameBufferType === undefined) return;
    for (const t of [...this.down, ...this.up, ...this.glare.flat()]) {
      t.texture.type = frameBufferType as TextureDataType;
    }
  }

  override dispose(): void {
    super.dispose();
    for (const t of [...this.down, ...this.up, ...this.glare.flat()]) t.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.streakMat.dispose();
    this.quad.geometry.dispose();
  }
}
