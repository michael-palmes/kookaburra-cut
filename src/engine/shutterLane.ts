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

interface LaneState {
  frame: FramebufferTexture;
  sums: [WebGLRenderTarget, WebGLRenderTarget];
  accumulate: ShaderMaterial;
  resolve: ShaderMaterial;
  mesh: Mesh;
  scene: Scene;
  camera: Camera;
  size: Vector2;
}

let lane: LaneState | null = null;
const _origin = new Vector2(0, 0);

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

function makeSum(w: number, h: number): WebGLRenderTarget {
  return new WebGLRenderTarget(w, h, {
    type: FloatType,
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
  const mesh = new Mesh(new PlaneGeometry(2, 2), accumulate);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  lane = {
    // Linear-tagged on purpose: copyTexSubImage2D into an sRGB-tagged texture is an invalid-operation no-op, and the raw display bytes are what the sum wants.
    frame: new FramebufferTexture(w, h),
    sums: [makeSum(w, h), makeSum(w, h)],
    accumulate,
    resolve,
    mesh,
    scene,
    camera: new Camera(),
    size: new Vector2(w, h),
  };
  return lane;
}

/** Frees the lane's targets (about 300 MB at 4K); the next accumulated frame re-allocates them. */
export function releaseShutterLane(): void {
  if (!lane) return;
  lane.frame.dispose();
  lane.sums[0].dispose();
  lane.sums[1].dispose();
  lane.accumulate.dispose();
  lane.resolve.dispose();
  lane.mesh.geometry.dispose();
  lane = null;
}

/** Renders `count` samples through `renderSample` (each must leave its finished frame in the canvas) and leaves their rounded byte mean in the canvas. */
export function accumulateFrame(
  gl: WebGLRenderer,
  width: number,
  height: number,
  count: number,
  renderSample: (index: number) => void,
): void {
  const st = ensureLane(width, height);
  const prevTarget = gl.getRenderTarget();
  const prevAutoClear = gl.autoClear;
  let read = 0;
  for (let i = 0; i < count; i++) {
    renderSample(i);
    gl.setRenderTarget(null);
    gl.copyFramebufferToTexture(st.frame, _origin);
    const write = 1 - read;
    st.mesh.material = st.accumulate;
    st.accumulate.uniforms.uSum.value = st.sums[read].texture;
    st.accumulate.uniforms.uFrame.value = st.frame;
    st.accumulate.uniforms.uFirst.value = i === 0 ? 1 : 0;
    gl.setRenderTarget(st.sums[write]);
    gl.autoClear = false;
    gl.render(st.scene, st.camera);
    gl.autoClear = prevAutoClear;
    read = write;
  }
  st.mesh.material = st.resolve;
  st.resolve.uniforms.uSum.value = st.sums[read].texture;
  st.resolve.uniforms.uCount.value = count;
  gl.setRenderTarget(null);
  gl.autoClear = false;
  gl.render(st.scene, st.camera);
  gl.autoClear = prevAutoClear;
  gl.setRenderTarget(prevTarget);
}
