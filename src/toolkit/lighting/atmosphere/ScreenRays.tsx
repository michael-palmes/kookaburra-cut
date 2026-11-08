import { useLayoutEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Color,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type Object3D,
  type Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { LOOK_GLSL_HASH } from "../../stage/scene3d/kit/glsl";

type V3 = [number, number, number];

/** Fixed tap count: export contract once shipped. */
export const RAY_SAMPLES = 72;
/** The occlusion pass renders at this fraction of the frame on each axis. */
export const RAY_OCCLUSION_SCALE = 0.25;

export interface ScreenRaysProps {
  /** World position of the light; it may sit off frame. */
  source: V3;
  color: string;
  intensity: number;
  /** Fraction of the way to the source each pixel marches. */
  length?: number;
  /** Per-tap falloff. */
  decay?: number;
  /** Radius of the source's glow, in frame heights. */
  spread?: number;
  /** Angular bars round the source (a window or blind it shines through). */
  stripes?: { count: number; duty: number; softness: number; seed: number } | null;
}

// language=GLSL
const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// language=GLSL
const FRAGMENT = /* glsl */ `
${LOOK_GLSL_HASH}
uniform sampler2D uOcclusion;
uniform vec2 uSource;
uniform float uAspect;
uniform vec3 uColor;
uniform float uLength;
uniform float uDecay;
uniform float uSpread;
uniform float uStripeOn;
uniform float uStripeCount;
uniform float uStripeDuty;
uniform float uStripeSoft;
uniform int uStripeSeed;
varying vec2 vUv;

float stripes(vec2 p) {
  if (uStripeOn < 0.5) return 1.0;
  vec2 d = p - uSource;
  d.x *= uAspect;
  float a = atan(d.y, d.x) / 6.283185307179586 * uStripeCount * 4.0;
  float cell = floor(a);
  float f = a - cell;
  ivec2 id = ivec2(int(cell) + 4096, uStripeSeed);
  float duty = uStripeDuty * (0.55 + hash21(id));
  float gain = 0.35 + 0.65 * hash21(id + ivec2(0, 977));
  float edge = max(uStripeSoft * 0.5, 1e-3);
  return gain * smoothstep(0.0, edge, f) * (1.0 - smoothstep(duty - edge, duty, f));
}

float glow(vec2 p) {
  vec2 d = p - uSource;
  d.x *= uAspect;
  return exp(-length(d) / uSpread);
}

float open(vec2 p) {
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
  return textureLod(uOcclusion, p, 0.0).r;
}

void main() {
  vec2 delta = (vUv - uSource) * (uLength / ${RAY_SAMPLES}.0);
  vec2 p = vUv - delta * hash21(ivec2(gl_FragCoord.xy));
  float fall = 1.0;
  float sum = 0.0;
  for (int i = 0; i < ${RAY_SAMPLES}; i++) {
    sum += open(p) * glow(p) * fall;
    fall *= uDecay;
    p -= delta;
  }
  sum *= stripes(vUv) / ${RAY_SAMPLES}.0;
  float self = mix(1.0, open(vUv), 0.9);
  gl_FragColor = vec4(uColor * sum * self, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function fullScreenTriangle(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  return g;
}

/** Content the occlusion pass leaves out: backgrounds, the frame layers, translucent parts, text and anything flagged. */
function occludes(o: Object3D): boolean {
  const mesh = o as Mesh;
  if (!mesh.isMesh) return false;
  if (o.renderOrder < 0 || o.userData.atmosNoOcclude) return false;
  if ("_private_text" in o) return false;
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
  return !mats.some((m) => m.transparent);
}

/** Prototype: screen-space light shafts (Mitchell's radial march). A quarter-size pass draws everything that blocks light black on white; a full-frame triangle then marches each pixel toward the light's screen position, so the handset casts streaks. */
export function ScreenRays({
  source,
  color,
  intensity,
  length = 0.9,
  decay = 0.985,
  spread = 0.45,
  stripes = null,
}: ScreenRaysProps) {
  const meshRef = useRef<Mesh>(null);
  const geometry = useMemo(fullScreenTriangle, []);
  const target = useMemo(() => new WebGLRenderTarget(1, 1, { depthBuffer: true }), []);
  const black = useMemo(() => new MeshBasicMaterial({ color: 0x000000 }), []);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        name: "kookaburra-screen-rays",
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uOcclusion: { value: target.texture },
          uSource: { value: new Vector2() },
          uAspect: { value: 1 },
          uColor: { value: new Color() },
          uLength: { value: 0.9 },
          uDecay: { value: 0.985 },
          uSpread: { value: 0.45 },
          uStripeOn: { value: 0 },
          uStripeCount: { value: 9 },
          uStripeDuty: { value: 0.4 },
          uStripeSoft: { value: 0.2 },
          uStripeSeed: { value: 1 },
        },
      }),
    [target],
  );
  useLayoutEffect(
    () => () => {
      geometry.dispose();
      target.dispose();
      black.dispose();
      material.dispose();
    },
    [geometry, target, black, material],
  );

  useLayoutEffect(() => {
    const u = material.uniforms;
    (u.uColor.value as Color).set(color).multiplyScalar(intensity);
    u.uLength.value = length;
    u.uDecay.value = decay;
    u.uSpread.value = spread;
    u.uStripeOn.value = stripes ? 1 : 0;
    if (stripes) {
      u.uStripeCount.value = stripes.count;
      u.uStripeDuty.value = stripes.duty;
      u.uStripeSoft.value = stripes.softness;
      u.uStripeSeed.value = stripes.seed;
    }
  });

  const onBeforeRender = useMemo(() => {
    const world = new Vector3();
    const size = new Vector2();
    const clear = new Color();
    return (renderer: WebGLRenderer, scene: Scene, camera: Camera) => {
      const self = meshRef.current;
      if (!self) return;
      const outer = renderer.getRenderTarget();
      if (outer) size.set(outer.width, outer.height);
      else renderer.getDrawingBufferSize(size);
      const w = Math.max(1, Math.ceil(size.x * RAY_OCCLUSION_SCALE));
      const h = Math.max(1, Math.ceil(size.y * RAY_OCCLUSION_SCALE));
      if (target.width !== w || target.height !== h) target.setSize(w, h);

      world.set(source[0], source[1], source[2]).project(camera);
      const u = material.uniforms;
      (u.uSource.value as Vector2).set(world.x * 0.5 + 0.5, world.y * 0.5 + 0.5);
      u.uAspect.value = size.x / size.y;

      const hidden: Object3D[] = [];
      scene.traverseVisible((o) => {
        if ((o as Mesh).isMesh && !occludes(o)) hidden.push(o);
      });
      for (const o of hidden) o.visible = false;
      const prevOverride = scene.overrideMaterial;
      const prevBackground = scene.background;
      const prevAutoClear = renderer.autoClear;
      const prevShadows = renderer.shadowMap.autoUpdate;
      renderer.getClearColor(clear);
      const prevAlpha = renderer.getClearAlpha();
      scene.overrideMaterial = black;
      scene.background = null;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0xffffff, 1);
      renderer.render(scene, camera);
      renderer.setRenderTarget(outer);
      renderer.setClearColor(clear, prevAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadows;
      scene.background = prevBackground;
      scene.overrideMaterial = prevOverride;
      for (const o of hidden) o.visible = true;
    };
  }, [material, target, black, source[0], source[1], source[2]]);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={1000}
      onBeforeRender={onBeforeRender as unknown as Mesh["onBeforeRender"]}
    />
  );
}
