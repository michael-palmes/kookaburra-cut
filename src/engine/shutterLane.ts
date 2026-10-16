import {
  Camera,
  FloatType,
  FramebufferTexture,
  GLSL3,
  Mesh,
  NearestFilter,
  NoBlending,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { vertexShader300 } from "./transitionShader";

// Motion blur by accumulation: samples render on the original paths, sum as exact bytes, and a still pixel averages back to itself.

const accumulateFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uSum;
  uniform sampler2D uFrame;
  uniform float uFirst;
  out vec4 fragColor;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 bytes = floor(texelFetch(uFrame, p, 0) * 255.0 + 0.5);
    fragColor = (uFirst > 0.5 ? vec4(0.0) : texelFetch(uSum, p, 0)) + bytes;
  }
`;

const resolveFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uSum;
  uniform float uCount;
  out vec4 fragColor;
  void main() {
    vec4 sum = texelFetch(uSum, ivec2(gl_FragCoord.xy), 0);
    fragColor = floor(sum / uCount + 0.5) / 255.0;
  }
`;

/** Pixels per side of the block one diff texel covers. EXPORT CONTRACT (it decides which frames skip the lane). */
const DIFF_BLOCK = 32;

const diffFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uA;
  uniform sampler2D uB;
  uniform ivec2 uSize;
  out vec4 fragColor;
  void main() {
    ivec2 base = ivec2(gl_FragCoord.xy) * ${DIFF_BLOCK};
    float d = 0.0;
    for (int y = 0; y < ${DIFF_BLOCK}; y++) {
      for (int x = 0; x < ${DIFF_BLOCK}; x++) {
        ivec2 p = min(base + ivec2(x, y), uSize - 1);
        vec4 delta = abs(texelFetch(uA, p, 0) - texelFetch(uB, p, 0));
        d = max(d, max(max(delta.r, delta.g), max(delta.b, delta.a)));
      }
    }
    fragColor = vec4(d > 0.0 ? 1.0 : 0.0);
  }
`;

interface LaneState {
  frame: FramebufferTexture;
  kept: FramebufferTexture;
  sums: [WebGLRenderTarget, WebGLRenderTarget];
  diff: WebGLRenderTarget;
  diffPixels: Uint8Array;
  accumulate: ShaderMaterial;
  resolve: ShaderMaterial;
  compare: ShaderMaterial;
  mesh: Mesh;
  scene: Scene;
  camera: Camera;
  size: Vector2;
}

let lane: LaneState | null = null;
let generation = 0;
const _origin = new Vector2(0, 0);

/** Bumps whenever the lane's targets are reallocated or freed, so a held accumulator can tell it went stale. */
export function shutterLaneGeneration(): number {
  return generation;
}

function makeMaterial(fragmentShader: string, uniforms: ShaderMaterial["uniforms"]) {
  return new ShaderMaterial({
    uniforms,
    vertexShader: vertexShader300,
    fragmentShader,
    glslVersion: GLSL3,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

function makeTarget(w: number, h: number, float: boolean): WebGLRenderTarget {
  return new WebGLRenderTarget(w, h, {
    type: float ? FloatType : UnsignedByteType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

function ensureLane(w: number, h: number): LaneState {
  if (lane && lane.size.x === w && lane.size.y === h) return lane;
  releaseShutterLane();
  const accumulate = makeMaterial(accumulateFragment, {
    uSum: { value: null },
    uFrame: { value: null },
    uFirst: { value: 1 },
  });
  const resolve = makeMaterial(resolveFragment, {
    uSum: { value: null },
    uCount: { value: 1 },
  });
  const compare = makeMaterial(diffFragment, {
    uA: { value: null },
    uB: { value: null },
    uSize: { value: new Vector2(w, h) },
  });
  const mesh = new Mesh(new PlaneGeometry(2, 2), accumulate);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  const dw = Math.ceil(w / DIFF_BLOCK);
  const dh = Math.ceil(h / DIFF_BLOCK);
  lane = {
    // Linear-tagged on purpose: copyTexSubImage2D into an sRGB-tagged texture is an invalid-operation no-op, and the raw display bytes are what the sum wants.
    frame: new FramebufferTexture(w, h),
    kept: new FramebufferTexture(w, h),
    sums: [makeTarget(w, h, true), makeTarget(w, h, true)],
    diff: makeTarget(dw, dh, false),
    diffPixels: new Uint8Array(dw * dh * 4),
    accumulate,
    resolve,
    compare,
    mesh,
    scene,
    camera: new Camera(),
    size: new Vector2(w, h),
  };
  return lane;
}

/** Frees the lane's targets (about 370 MB at 4K); the next accumulated frame re-allocates them. */
export function releaseShutterLane(): void {
  if (!lane) return;
  generation++;
  lane.frame.dispose();
  lane.kept.dispose();
  lane.sums[0].dispose();
  lane.sums[1].dispose();
  lane.diff.dispose();
  lane.accumulate.dispose();
  lane.resolve.dispose();
  lane.compare.dispose();
  lane.mesh.geometry.dispose();
  lane = null;
}

function drawQuad(gl: WebGLRenderer, st: LaneState, material: ShaderMaterial): void {
  st.mesh.material = material;
  const prevAutoClear = gl.autoClear;
  gl.autoClear = false;
  gl.render(st.scene, st.camera);
  gl.autoClear = prevAutoClear;
}

/** One frame's running sum. Each `add` takes the canvas's finished sample; `resolve` writes the rounded mean back to the canvas. */
export interface ShutterAccumulator {
  /** Adds the canvas's frame; `keep` also holds it for `lastMatchesKept`. */
  add(keep?: boolean): void;
  /** True when the last added frame equals the kept one byte for byte (nothing moved between them). */
  lastMatchesKept(): boolean;
  resolve(): void;
}

export function startAccumulation(
  gl: WebGLRenderer,
  width: number,
  height: number,
): ShutterAccumulator {
  const st = ensureLane(width, height);
  let read = 0;
  let count = 0;
  return {
    add(keep = false) {
      const prevTarget = gl.getRenderTarget();
      const texture = keep ? st.kept : st.frame;
      gl.setRenderTarget(null);
      gl.copyFramebufferToTexture(texture, _origin);
      const write = 1 - read;
      st.accumulate.uniforms.uSum.value = st.sums[read].texture;
      st.accumulate.uniforms.uFrame.value = texture;
      st.accumulate.uniforms.uFirst.value = count === 0 ? 1 : 0;
      gl.setRenderTarget(st.sums[write]);
      drawQuad(gl, st, st.accumulate);
      gl.setRenderTarget(prevTarget);
      read = write;
      count++;
    },
    lastMatchesKept() {
      const prevTarget = gl.getRenderTarget();
      st.compare.uniforms.uA.value = st.kept;
      st.compare.uniforms.uB.value = st.frame;
      gl.setRenderTarget(st.diff);
      drawQuad(gl, st, st.compare);
      gl.readRenderTargetPixels(st.diff, 0, 0, st.diff.width, st.diff.height, st.diffPixels);
      gl.setRenderTarget(prevTarget);
      return st.diffPixels.every((v) => v === 0);
    },
    resolve() {
      const prevTarget = gl.getRenderTarget();
      st.resolve.uniforms.uSum.value = st.sums[read].texture;
      st.resolve.uniforms.uCount.value = count;
      gl.setRenderTarget(null);
      drawQuad(gl, st, st.resolve);
      gl.setRenderTarget(prevTarget);
    },
  };
}

/** Renders `count` samples through `renderSample` (each must leave its finished frame in the canvas) and leaves their rounded byte mean in the canvas. */
export function accumulateFrame(
  gl: WebGLRenderer,
  width: number,
  height: number,
  count: number,
  renderSample: (index: number) => void,
): void {
  const acc = startAccumulation(gl, width, height);
  for (let i = 0; i < count; i++) {
    renderSample(i);
    acc.add();
  }
  acc.resolve();
}
