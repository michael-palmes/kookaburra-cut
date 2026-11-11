import {
  type Camera,
  ClampToEdgeWrapping,
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  type Object3D,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Side,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import {
  bucketSize,
  captureDensity,
  captureSize,
  OPTICAL_MAX_LEVELS,
  OPTICAL_MAX_RADIUS,
  type OpticalBlurLevel,
  screenDensity,
  tapRadius,
} from "./opticalBlur";

// Premultiplied in, premultiplied out: every tap lands on a texel centre, the weights are normalised, so the pass conserves energy exactly.
const BLUR_VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uSigma;
uniform int uRadius;
void main() {
  vec2 base = gl_FragCoord.xy;
  vec4 sum = texture2D(tSrc, base * uTexel);
  float total = 1.0;
  float inv = uRadius > 0 ? -0.5 / (uSigma * uSigma) : 0.0;
  for (int i = 1; i <= ${OPTICAL_MAX_RADIUS}; i++) {
    if (i > uRadius) break;
    float fi = float(i);
    float w = exp(fi * fi * inv);
    sum += w * (texture2D(tSrc, (base + uDir * fi) * uTexel) + texture2D(tSrc, (base - uDir * fi) * uTexel));
    total += 2.0 * w;
  }
  gl_FragColor = sum / total;
}
`;

const CARD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Back to straight alpha so the card blends, tone-maps and encodes exactly as the text it stands in for.
const CARD_FRAGMENT = /* glsl */ `
uniform sampler2D tBlur;
uniform vec2 uUvScale;
varying vec2 vUv;
void main() {
  vec4 p = texture2D(tBlur, vUv * uUvScale);
  if (p.a < 1.0 / 512.0) discard;
  gl_FragColor = vec4(p.rgb / p.a, min(p.a, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function captureTarget(): WebGLRenderTarget {
  const t = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
  t.texture.generateMipmaps = false;
  return t;
}

/** How the text this card stands in for draws, copied so the card composites in the same lane. */
export interface CardLook {
  toneMapped: boolean;
  depthTest: boolean;
  side: Side;
}

export function createCardMaterial(look: CardLook): ShaderMaterial {
  const material = new ShaderMaterial({
    vertexShader: CARD_VERTEX,
    fragmentShader: CARD_FRAGMENT,
    uniforms: { tBlur: { value: null }, uUvScale: { value: new Vector2(1, 1) } },
    transparent: true,
    depthTest: look.depthTest,
    // A defocused halo never occludes: writing depth over it would cut later beams and haze.
    depthWrite: false,
    side: look.side,
  });
  material.toneMapped = look.toneMapped;
  return material;
}

interface LevelTargets {
  a: WebGLRenderTarget;
  b: WebGLRenderTarget;
}

/** What one capture needs from the headline: this frame's levels, a serial that changes whenever its uniforms do, and writers that put the units' uniforms into a level's capture state or back to the main pass. */
export interface OpticalBlurFrame {
  serial: number;
  levels: readonly OpticalBlurLevel[];
  applyCapture(level: number): void;
  applyMain(): void;
}

const savedClear = new Color();
const centre = new Vector3();
const drawSize = new Vector2();

/** The capture lane: per level, the planar text draws into a layout-space half-float target at a σ-scaled density, then two separable gaussian passes; the cards sample the result. Runs inside a card's onBeforeRender, once per frame state (supersample jitter and mirror passes reuse it, since the capture is camera-free apart from its density). */
export class OpticalBlurPass {
  readonly cards: ShaderMaterial[];
  private readonly targets: Array<LevelTargets | null> = [];
  private readonly camera = new OrthographicCamera();
  private readonly blur = new ShaderMaterial({
    vertexShader: BLUR_VERTEX,
    fragmentShader: BLUR_FRAGMENT,
    uniforms: {
      tSrc: { value: null },
      uTexel: { value: new Vector2() },
      uDir: { value: new Vector2() },
      uSigma: { value: 1 },
      uRadius: { value: 0 },
    },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  private readonly quad = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quadGeometry = new PlaneGeometry(2, 2);
  private key = "";
  private busy = false;

  constructor(look: CardLook) {
    this.cards = Array.from({ length: OPTICAL_MAX_LEVELS }, () => createCardMaterial(look));
    const mesh = new Mesh(this.quadGeometry, this.blur);
    mesh.frustumCulled = false;
    this.quad.add(mesh);
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
  }

  /** Captures and blurs every level of `frame` unless this exact state already has. `frameObject` is the text's layout frame (the card group), `root` holds only the text meshes. */
  run(
    renderer: WebGLRenderer,
    viewCamera: Camera,
    frameObject: Object3D,
    root: Object3D,
    frame: OpticalBlurFrame,
  ): void {
    if (this.busy || frame.levels.length === 0) return;
    renderer.getDrawingBufferSize(drawSize);
    const world = frameObject.matrixWorld;
    const worldScale = world.getMaxScaleOnAxis();
    const proj = viewCamera.projectionMatrix.elements;
    const perspective = proj[11] === -1;
    const densities = frame.levels.map((level) => {
      centre.set((level.rect[0] + level.rect[2]) / 2, (level.rect[1] + level.rect[3]) / 2, 0);
      centre.applyMatrix4(world).applyMatrix4(viewCamera.matrixWorldInverse);
      const rho = screenDensity(proj[5], perspective, -centre.z, worldScale, drawSize.y);
      return captureDensity(level.sigma, rho, level.rect);
    });
    const key = `${frame.serial}|${densities.join(",")}`;
    if (key === this.key) return;
    this.busy = true;
    const outer = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(savedClear);
    const clearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    try {
      this.camera.matrixWorld.copy(world);
      this.camera.matrixWorldInverse.copy(world).invert();
      for (let i = 0; i < frame.levels.length; i++) {
        this.captureLevel(renderer, root, frame, frame.levels[i], i, densities[i]);
      }
    } finally {
      frame.applyMain();
      renderer.setRenderTarget(outer);
      renderer.setClearColor(savedClear, clearAlpha);
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadows;
      this.busy = false;
    }
    this.key = key;
  }

  private captureLevel(
    renderer: WebGLRenderer,
    root: Object3D,
    frame: OpticalBlurFrame,
    level: OpticalBlurLevel,
    i: number,
    density: number,
  ): void {
    const [w, h] = captureSize(level.rect, density);
    const W = bucketSize(w);
    const H = bucketSize(h);
    let t = this.targets[i];
    if (!t) {
      t = { a: captureTarget(), b: captureTarget() };
      this.targets[i] = t;
    }
    if (t.a.width !== W || t.a.height !== H) {
      t.a.setSize(W, H);
      t.b.setSize(W, H);
    }
    const [x0, y0, x1, y1] = level.rect;
    const texelX = (x1 - x0) / w;
    const texelY = (y1 - y0) / h;
    const cam = this.camera;
    cam.left = x0;
    cam.right = x0 + W * texelX;
    cam.bottom = y0;
    cam.top = y0 + H * texelY;
    cam.near = -1e4;
    cam.far = 1e4;
    cam.updateProjectionMatrix();
    frame.applyCapture(i);
    renderer.setRenderTarget(t.a);
    renderer.clear(true, false, false);
    renderer.render(root, cam);
    this.blurPass(renderer, t.a, t.b, 1, 0, level.sigma / texelX);
    this.blurPass(renderer, t.b, t.a, 0, 1, level.sigma / texelY);
    const card = this.cards[i].uniforms;
    card.tBlur.value = t.a.texture;
    (card.uUvScale.value as Vector2).set(w / W, h / H);
  }

  private blurPass(
    renderer: WebGLRenderer,
    src: WebGLRenderTarget,
    dst: WebGLRenderTarget,
    dx: number,
    dy: number,
    sigmaTexels: number,
  ): void {
    const u = this.blur.uniforms;
    u.tSrc.value = src.texture;
    (u.uTexel.value as Vector2).set(1 / src.width, 1 / src.height);
    (u.uDir.value as Vector2).set(dx, dy);
    u.uSigma.value = Math.max(sigmaTexels, 1e-6);
    u.uRadius.value = tapRadius(sigmaTexels);
    renderer.setRenderTarget(dst);
    renderer.render(this.quad, this.quadCamera);
  }

  /** Frees the capture targets once nothing blurs (they come back on the next blurred frame). */
  release(): void {
    for (const t of this.targets) {
      t?.a.dispose();
      t?.b.dispose();
    }
    this.targets.length = 0;
    this.key = "";
  }

  dispose(): void {
    for (const t of this.targets) {
      t?.a.dispose();
      t?.b.dispose();
    }
    this.targets.length = 0;
    for (const card of this.cards) card.dispose();
    this.blur.dispose();
    this.quadGeometry.dispose();
  }
}
