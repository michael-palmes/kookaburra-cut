import { Environment, Lightformer, useGLTF, useTexture } from "@react-three/drei";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Box3,
  type BufferAttribute,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  type Group,
  LinearFilter,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  type Object3D,
  RGBAFormat,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from "three";
import { useClipTexture } from "../../engine/clipTexture";
import { useSceneConsumesDevices } from "../../engine/deviceRegistry";
import { ease } from "../../engine/ease";
import { isExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import { presentSlideshowActive } from "../../engine/presentMode";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext, SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import type { SceneDeviceProps } from "../../engine/sceneDoc";
import { coverCropRect, remapUv, type UvRect } from "../../engine/screenFit";
import { useTimeline } from "../../engine/timeline";
import { useEditorStore } from "../../store/editorStore";
import { preparingVideoTexture } from "../media/preparingTexture";
import { useSceneStaged, useStageMapShadows } from "../stage/context";
import type { V3 } from "../types";
import { DEVICE_CATALOG, type DeviceId, deviceColour } from "./catalog";
import { HIDDEN_NODES } from "./models";

/** Media shown on the device screen. Videos ride the deterministic clip-frame pipeline. */
export interface DeviceMediaSpec {
  /** Project-relative path, e.g. `"assets/demo.mp4"` or `"assets/screen.png"`. */
  src: string;
  kind: "video" | "image";
  /** Video only: when playback starts, in ms of scene-local time (default 0). */
  startMs?: number;
  /** Cover-fit is the rule: fill the screen, keep the media's aspect, crop the overflow. */
  fit?: "cover";
}

export type DeviceMotionPreset = "none" | "turntable" | "float" | "tilt-reveal" | "push-in";

export interface DeviceMotionSpec {
  preset: DeviceMotionPreset;
  /** `turntable`: idle spin about Y, degrees/second (default 18). */
  degPerSec?: number;
  /** `float`: vertical bob amplitude in world units (default 0.12). */
  amplitude?: number;
  /** `float`: bob frequency in cycles/second (default 0.4). */
  hz?: number;
  /** `tilt-reveal` / `push-in`: intro length in ms (defaults 1000 / 1200). */
  durationMs?: number;
}

export interface DevicePlacement {
  position?: V3;
  /** Base rotation in DEGREES (scene documents are authored in degrees). */
  rotationDeg?: V3;
  /** Multiplier on the auto-fit scale. */
  scale?: number;
}

export type DeviceShadowMode = "soft" | "long" | "sun" | "none";

export interface DeviceProps {
  /** Catalog id, e.g. `"iphone-15-pro"`. */
  model: DeviceId;
  /** Colour id from the catalog (default: the model's default colour). */
  colour?: string;
  media?: DeviceMediaSpec;
  placement?: DevicePlacement;
  motion?: DeviceMotionSpec;
  /** Ground shadow: defaults to `"soft"`, or `"none"` under a map-shadowed `<SceneStage>` since the real shadow replaces the procedural blob; an explicit value wins. */
  shadow?: DeviceShadowMode;
  /** Bundle the lit set (rig + one-shot environment); defaults true, or false under a lighting `<SceneStage>` since the stage lights the scene; an explicit value wins. */
  lit?: boolean;
  /** Laptop lid opening in degrees (0 closed, default the model's authored angle); ignored by devices with no hinge. */
  lidDeg?: number;
}

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
/** Present-slideshow turntable sway amplitude: 45 degrees each way. */
const TURNTABLE_SWAY_RAD = Math.PI / 4;
/** World-space height devices auto-fit to; the framing constant shared with DeviceMockup. */
const TARGET_WORLD_HEIGHT = 2.6;
/** Ground plane sits just under the auto-fit device's bottom edge. */
const GROUND_EPSILON = 0.02;
/** Yaw of the long shadow: away from the key light at [4, 6, 5] (floor direction −4, −5). */
const LONG_SHADOW_YAW = Math.atan2(5, -4) - Math.PI / 2;

// ── Sun-sweep shadow (export contract) ───────────────────────────────
/** Sweep length in world units before the placement scale (≈ 1.3 device heights). */
const SUN_LENGTH = 3.4;
/** Penumbra half-widths at the root and the tail of the sweep. */
const SUN_BLUR_NEAR = 0.06;
const SUN_BLUR_FAR = 0.85;
/** Rounded-rect corner radius of the silhouette. */
const SUN_CORNER_RADIUS = 0.18;
/** How far behind the device the flat shadow plane sits. */
const SUN_Z_BACK = -0.45;

/** Geometric specular AA (Kaplanyan/Tokuyoshi-Kaplanyan): widens roughness by the perturbed-normal's screen-space variance to kill normal-map specular shimmer (three's own geometryRoughness derives from the non-perturbed normal and misses it); the σ²/κ constants are export contract, applied only to Device's private material clones, never the shared drei glTF cache that DeviceMockup/HeroObject also read. */
const GSAA_FRAGMENT = /* glsl */ `#include <lights_physical_fragment>
{
	vec3 gsaaDx = dFdx( normal );
	vec3 gsaaDy = dFdy( normal );
	float gsaaVariance = 0.25 * ( dot( gsaaDx, gsaaDx ) + dot( gsaaDy, gsaaDy ) );
	float gsaaKernel = min( gsaaVariance, 0.18 );
	material.roughness = min( sqrt( material.roughness * material.roughness + gsaaKernel ), 1.0 );
}`;

function applyDeviceGsaa(material: Material): void {
  if (!(material as MeshStandardMaterial).isMeshStandardMaterial) return;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_physical_fragment>",
      GSAA_FRAGMENT,
    );
  };
  // One stable cache key: all GSAA'd device materials share program variants normally.
  material.customProgramCacheKey = () => "kookaburra-device-gsaa-v1";
}

function materialName(material: Material | Material[]): string | undefined {
  return Array.isArray(material) ? material[0]?.name : material.name;
}

/** Bakes a cover-crop rect into the screen mesh's UVs; stashes the pristine UV set on first bake so a media change re-bakes from the original (re-baking the same rect is a no-op via `uvRectKey`), cloning geometry first since `Object3D.clone` shares geometry with drei's cache. */
function bakeScreenUvs(mesh: Mesh, rect: UvRect): void {
  const key = `${rect.u0}/${rect.v0}/${rect.u1}/${rect.v1}`;
  if (mesh.userData.uvRectKey === key) return;
  if (!mesh.userData.screenBaseUv) {
    mesh.geometry = mesh.geometry.clone();
    const uv = mesh.geometry.getAttribute("uv") as BufferAttribute | undefined;
    if (!uv) return;
    // Read via the attribute API, never the raw array: glTF vertex data is often interleaved (this glb strides 32 bytes), so raw `[i * 2]` indexing reads positions and bakes garbage UVs; getX/getY handle the stride.
    const base = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      base[i * 2] = uv.getX(i);
      base[i * 2 + 1] = uv.getY(i);
    }
    mesh.userData.screenBaseUv = base;
  }
  const base = mesh.userData.screenBaseUv as Float32Array;
  const uv = mesh.geometry.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const [u, v] = remapUv(base[i * 2], base[i * 2 + 1], rect);
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  mesh.userData.uvRectKey = key;
}

/** Video media: drives the screen material from the shared clip-frame pipeline. */
function ScreenVideo(props: {
  src: string;
  startMs: number;
  material: MeshBasicMaterial;
  screens: Mesh[];
  screenAspect: number;
}) {
  const { src, startMs, material, screens, screenAspect } = props;

  // The readiness node lives in this component's own subtree since own-subtree refs attach before layout effects run; a parent's ref is still null during the mount commit, which previously left the binding effect bailing on stale deps and the screen black for the whole clamp window.
  const readyRef = useRef<Group>(null);

  // Until the first frame binds, the screen shows the "Preparing video…" card, except during export where it stays plain black (belt-and-braces atop the preamble/barrier guarantees; the frame bind overwrites `map`, so no cleanup is needed).
  const onPending = useCallback(() => {
    if (isExporting()) {
      material.map = null;
      material.color.set(0x000000);
      material.needsUpdate = true;
      return;
    }
    const rect = coverCropRect(screenAspect, screenAspect, false); // identity, unflipped
    for (const mesh of screens) bakeScreenUvs(mesh, rect);
    material.map = preparingVideoTexture(screenAspect, false);
    material.color.set(0xffffff);
    material.needsUpdate = true;
  }, [material, screens, screenAspect]);
  const onBound = useCallback(() => material.color.set(0xffffff), [material]);

  const { info } = useClipTexture({
    src,
    startMs,
    material,
    readyObjectRef: readyRef,
    onPending,
    onBound,
  });

  useLayoutEffect(() => {
    if (!info) return;
    // Pre-flipped clip bitmaps put the source's bottom row at v=0, but glTF screens have v=0 at the top; flip V in the baked crop (see engine/screenFit.ts).
    const rect = coverCropRect(info.width / info.height, screenAspect, true);
    for (const mesh of screens) bakeScreenUvs(mesh, rect);
  }, [info, screens, screenAspect]);

  return <group ref={readyRef} />;
}

/** Image media: a static texture on the screen material (the DeviceMockup path). */
function ScreenImage(props: {
  src: string;
  material: MeshBasicMaterial;
  screens: Mesh[];
  screenAspect: number;
  projectId: string;
}) {
  const { src, material, screens, screenAspect, projectId } = props;
  const tex = useTexture(resolveAssetUrl(projectId, src));

  useLayoutEffect(() => {
    // Match the loader's colour space and the glTF flipY convention (DeviceMockup precedent).
    tex.colorSpace = SRGBColorSpace;
    tex.flipY = false;
    tex.needsUpdate = true;
    material.map = tex;
    material.color.set(0xffffff);
    material.needsUpdate = true;
    const image = tex.image as { width?: number; height?: number } | undefined;
    const aspect = image?.width && image?.height ? image.width / image.height : screenAspect;
    const rect = coverCropRect(aspect, screenAspect, false);
    for (const mesh of screens) bakeScreenUvs(mesh, rect);
  }, [tex, material, screens, screenAspect]);

  return null;
}

/** Procedural shadow alpha textures: pure functions of pixel coordinates (DataTexture, no canvas rasteriser), generated once per run; `alphaMap` samples the green channel and all channels carry the same value. */
function makeShadowTexture(
  width: number,
  height: number,
  alphaAt: (u: number, v: number) => number,
): DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = alphaAt((x + 0.5) / width, (y + 0.5) / height);
      const byte = Math.round(Math.min(1, Math.max(0, a)) * 255);
      const i = (y * width + x) * 4;
      data[i] = byte;
      data[i + 1] = byte;
      data[i + 2] = byte;
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, width, height, RGBAFormat);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

let softTex: DataTexture | undefined;
function softShadowTexture(): DataTexture {
  if (!softTex) {
    // Tight elliptical falloff: strong core under the device, smooth to nothing at the rim.
    softTex = makeShadowTexture(64, 64, (u, v) => {
      const dx = u * 2 - 1;
      const dy = v * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      const t = Math.max(0, 1 - r);
      return 0.55 * t * t;
    });
  }
  return softTex;
}

let longTex: DataTexture | undefined;
function longShadowTexture(): DataTexture {
  if (!longTex) {
    // "Long and smooth": u runs along the shadow's length (0 = under the device), v across its width; soft head, long eased tail, gentle width falloff.
    longTex = makeShadowTexture(128, 64, (u, v) => {
      const across = Math.max(0, 1 - Math.abs(v * 2 - 1));
      const head = Math.min(1, u / 0.08); // quick ramp-in so the shadow roots under the device
      const tail = (1 - u) ** 1.7;
      return 0.5 * across * across * head * tail;
    });
  }
  return longTex;
}

function DeviceShadow(props: { mode: "soft" | "long"; scale: number; groundY: number }) {
  const { mode, scale, groundY } = props;
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color(0x000000),
        alphaMap: mode === "soft" ? softShadowTexture() : longShadowTexture(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [mode],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);

  if (mode === "soft") {
    return (
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, groundY, 0]}
        scale={[2.1 * scale, 1.0 * scale, 1]}
      >
        <planeGeometry args={[1, 1]} />
        <primitive object={material} attach="material" />
      </mesh>
    );
  }
  return (
    <group rotation={[0, LONG_SHADOW_YAW, 0]}>
      {/* Length runs along local +x from under the device; the group yaws it away from the key light. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[1.7 * scale, groundY, 0]}
        scale={[4.2 * scale, 1.5 * scale, 1]}
      >
        <planeGeometry args={[1, 1]} />
        <primitive object={material} attach="material" />
      </mesh>
    </group>
  );
}

// language=GLSL
const SUN_VERT = /* glsl */ `
uniform vec2 uSize;
uniform vec2 uOffset;
varying vec2 vPos;
void main() {
  vPos = (uv - 0.5) * uSize + uOffset;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// language=GLSL
const SUN_FRAG = /* glsl */ `
uniform vec2 uHalf;
uniform float uRadius;
uniform float uLen;
uniform vec2 uBlur;
varying vec2 vPos;
const vec2 SUN_DIR = vec2(0.7071067811865476, -0.7071067811865476);
const float SUN_OPACITY = 0.34;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  float along = clamp(dot(vPos, SUN_DIR), 0.0, uLen);
  float t = along / uLen;
  vec2 q = vPos - SUN_DIR * along;
  float d = sdRoundBox(q, uHalf, uRadius);
  float blur = mix(uBlur.x, uBlur.y, t);
  float coverage = 1.0 - smoothstep(-blur, blur, d);
  float fade = pow(1.0 - t, 1.3);
  gl_FragColor = vec4(0.0, 0.0, 0.0, coverage * fade * SUN_OPACITY);
}
`;

/** The Rotato-style sun sweep: the device's rounded-rect silhouette extruded 45° down-right on a flat plane behind the device (an analytic SDF, pure function of the footprint — no light, no jitter, no accumulation). Sits outside the animated inner group like the blob shadows, so it tracks placement position/scale but deliberately not float/spin. */
function SunShadow({
  scale,
  aspect,
  fittedHeight,
}: {
  scale: number;
  aspect: number;
  fittedHeight: number;
}) {
  const dims = useMemo(() => {
    const halfH = (fittedHeight / 2) * scale;
    const halfW = halfH * aspect;
    const len = SUN_LENGTH * scale;
    const margin = (SUN_BLUR_FAR + 0.1) * scale;
    const along = len * Math.SQRT1_2;
    return {
      halfW,
      halfH,
      len,
      width: halfW * 2 + along + margin * 2,
      height: halfH * 2 + along + margin * 2,
      offsetX: along / 2,
      offsetY: -along / 2,
    };
  }, [scale, aspect, fittedHeight]);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: SUN_VERT,
        fragmentShader: SUN_FRAG,
        uniforms: {
          uSize: { value: new Vector2(dims.width, dims.height) },
          uOffset: { value: new Vector2(dims.offsetX, dims.offsetY) },
          uHalf: { value: new Vector2(dims.halfW, dims.halfH) },
          uRadius: { value: SUN_CORNER_RADIUS * scale },
          uLen: { value: dims.len },
          uBlur: { value: new Vector2(SUN_BLUR_NEAR * scale, SUN_BLUR_FAR * scale) },
        },
      }),
    [dims, scale],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);
  return (
    <mesh position={[dims.offsetX, dims.offsetY, SUN_Z_BACK * scale]}>
      <planeGeometry args={[dims.width, dims.height]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

/** The pillar device primitive: the export preamble awaits `preloadCatalogModels` / `preextractClips` / `preloadProjectImages` so every frame renders synchronously after load; see docs/determinism.md and docs/decisions.md. */
export function Device(props: DeviceProps) {
  const {
    model,
    colour,
    media,
    placement = {},
    motion = { preset: "none" },
    shadow,
    lit,
    lidDeg,
  } = props;
  const { position = [0, 0, 0], rotationDeg = [0, 0, 0], scale = 1 } = placement;

  const { localMs } = useTimeline();
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  const groupRef = useRef<Group>(null);

  const sceneIndex = useSceneContext()?.index;
  const introMs =
    motion.preset === "tilt-reveal"
      ? (motion.durationMs ?? 1000)
      : motion.preset === "push-in"
        ? (motion.durationMs ?? 1200)
        : null;
  useEffect(() => {
    if (sceneIndex === undefined || introMs === null) return;
    return registerPresentTiming(sceneIndex, { kind: "device-motion", toMs: introMs });
  }, [sceneIndex, introMs]);

  // Staged scenes light themselves; the bundled lit set stands down by default.
  const staged = useSceneStaged();
  const isLit = lit ?? !staged;
  // Map-shadowed stages: the device casts (and receives, VSM wants casters receiving) real shadows, and the procedural blob default flips off so the two systems never stack; explicit props win.
  const mapShadows = useStageMapShadows();
  const shadowMode = shadow ?? (mapShadows ? "none" : "soft");

  const spec = DEVICE_CATALOG[model];
  // A bad scene document must degrade, never tear down the canvas tree (bootTrap lesson).
  if (!spec) console.error(`Device: unknown model "${model}"`);

  const { scene } = useGLTF((spec ?? DEVICE_CATALOG["iphone-15-pro"]).glbUrl);
  const activeSpec = spec ?? DEVICE_CATALOG["iphone-15-pro"];
  // Memoised because custom tints mint a fresh spec per call, and colourSpec keys the clone below.
  const colourSpec = useMemo(() => deviceColour(activeSpec, colour), [activeSpec, colour]);

  // The media material is owned here (StrictMode-safe, see VideoClip) and starts black so a device with no media, or frames not yet bound, shows a dark plausible screen.
  const screenMaterial = useMemo(() => {
    const m = new MeshBasicMaterial({ color: new Color(0x000000) });
    m.toneMapped = false;
    return m;
  }, []);
  useLayoutEffect(() => () => screenMaterial.dispose(), [screenMaterial]);

  // Clone once per (model, colour) since drei's glTF cache is shared: hide helper nodes, swap the display material, and give every lit material a private clone (Object3D.clone shares materials) so colour overrides and GSAA apply without touching the shared cache that DeviceMockup/HeroObject also read; then recentre + auto-fit.
  const { root, fit, screens, aspect, fittedHeight, lidNode, lidBaseX } = useMemo(() => {
    const clone = scene.clone(true);
    const screens: Mesh[] = [];
    const hide: Object3D[] = [];
    let lidNode: Object3D | null = null;
    const prepared = new Map<Material, Material>();
    clone.traverse((obj: Object3D) => {
      if (HIDDEN_NODES.has(obj.name)) {
        hide.push(obj);
        return;
      }
      if (activeSpec.lid && obj.name === activeSpec.lid.node) lidNode = obj;
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const name = materialName(mesh.material);
      if (name === activeSpec.screen.material) {
        mesh.material = screenMaterial;
        screens.push(mesh);
        return;
      }
      if (Array.isArray(mesh.material)) return;
      let preparedMaterial = prepared.get(mesh.material);
      if (!preparedMaterial) {
        preparedMaterial = mesh.material.clone();
        const override = name ? colourSpec.overrides[name] : undefined;
        if (override?.color) {
          (preparedMaterial as unknown as { color?: Color }).color?.set(override.color);
        }
        const std = preparedMaterial as MeshStandardMaterial;
        if (override?.roughness !== undefined) std.roughness = override.roughness;
        if (override?.metalness !== undefined) std.metalness = override.metalness;
        applyDeviceGsaa(preparedMaterial);
        prepared.set(mesh.material, preparedMaterial);
      }
      mesh.material = preparedMaterial;
    });
    for (const obj of hide) obj.removeFromParent();

    clone.updateMatrixWorld(true);
    const box = new Box3().setFromObject(clone);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    clone.position.sub(center);
    const fitAxis = activeSpec.fit?.axis ?? "height";
    const fitTarget = activeSpec.fit?.target ?? TARGET_WORLD_HEIGHT;
    const fit =
      fitAxis === "width"
        ? size.x > 1e-6
          ? fitTarget / size.x
          : 1
        : size.y > 1e-6
          ? fitTarget / size.y
          : 1;
    // The fitted world height (pre-placement-scale); grounds shadows for any fit axis. Height fit uses the target directly so the legacy path stays byte-identical (size.y * (t / size.y) need not equal t in floating point).
    const fittedHeight = fitAxis === "width" ? size.y * fit : fitTarget;
    // The fitted body's width/height ratio; the sun shadow's silhouette footprint.
    const aspect = size.y > 1e-6 ? size.x / size.y : 0.5;
    // The hinge's authored rotation; the lid effect scales it by lidDeg / openDeg.
    const lidBaseX = lidNode ? (lidNode as Object3D).rotation.x : 0;
    // Perf-probe marker: the no-devices elimination pass hides these roots.
    clone.userData.kookaburraDevice = true;
    return { root: clone, fit, screens, aspect, fittedHeight, lidNode, lidBaseX };
  }, [scene, activeSpec, colourSpec, screenMaterial]);

  // Lid angle: a static pose from the doc (pure data, no clock), applied pre-paint.
  useLayoutEffect(() => {
    if (!lidNode || !activeSpec.lid) return;
    const open = Math.max(0, Math.min(activeSpec.lid.openDeg, lidDeg ?? activeSpec.lid.defaultDeg));
    (lidNode as Object3D).rotation.x = lidBaseX * (open / activeSpec.lid.openDeg);
  }, [lidNode, lidBaseX, lidDeg, activeSpec]);

  // Real shadows on map-shadowed stages flip the private clone's meshes; inert (no recompiles, no shadow passes) for unstaged scenes, where no shadow-casting light exists.
  useLayoutEffect(() => {
    root.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = mapShadows;
        mesh.receiveShadow = mapShadows;
      }
    });
  }, [root, mapShadows]);

  // Motion presets: pure functions of the timeline value, never the wall clock.
  const t = localMs / 1000;
  let spinY = 0;
  let floatY = 0;
  let introScale = 1;
  let introRotX = 0;
  let introRotY = 0;
  switch (motion.preset) {
    case "turntable": {
      const rate = (motion.degPerSec ?? 18) * DEG2RAD;
      // Slideshow holds are open-ended, where an endless 360 spin distracts; sway 45 degrees each way instead, with the peak sway speed matching the authored spin rate. Video playback and export keep the true turntable.
      spinY = presentSlideshowActive()
        ? TURNTABLE_SWAY_RAD * Math.sin((rate / TURNTABLE_SWAY_RAD) * t)
        : rate * t;
      break;
    }
    case "float":
      // Rises from the resting pose to amplitude and back, never below it: devices sit on the stage floor, so the old symmetric sine clipped through on the down half.
      floatY = (motion.amplitude ?? 0.12) * 0.5 * (1 - Math.cos(TWO_PI * (motion.hz ?? 0.4) * t));
      break;
    case "tilt-reveal": {
      // Entrance: eases from tilted-away to the resting pose, then holds.
      const p = ease("outCubic", Math.min(1, localMs / (motion.durationMs ?? 1000)));
      introRotX = (1 - p) * -14 * DEG2RAD;
      introRotY = (1 - p) * -40 * DEG2RAD;
      break;
    }
    case "push-in": {
      // Entrance: slightly small and angled, easing up to full framing.
      const p = ease("outCubic", Math.min(1, localMs / (motion.durationMs ?? 1200)));
      introScale = 0.86 + 0.14 * p;
      introRotY = (1 - p) * -8 * DEG2RAD;
      break;
    }
    default:
      break;
  }

  const groundY = -(fittedHeight / 2) * scale - GROUND_EPSILON;

  return (
    <group ref={groupRef} position={position}>
      {isLit && (
        <>
          <ambientLight intensity={0.7} />
          <directionalLight position={[4, 6, 5]} intensity={2.4} />
          <directionalLight position={[-5, 2, -3]} intensity={0.9} />
          {/* Procedural, offline environment (rendered once) so the titanium reads as metal; the DeviceMockup set. */}
          <Environment resolution={256} frames={1}>
            <Lightformer form="rect" intensity={2} position={[0, 3, 4]} scale={8} />
            <Lightformer form="rect" intensity={1.2} position={[-4, 1, 2]} scale={5} />
            <Lightformer form="rect" intensity={1} position={[4, -1, 3]} scale={5} />
          </Environment>
        </>
      )}
      {shadowMode === "sun" ? (
        <SunShadow scale={scale} aspect={aspect} fittedHeight={fittedHeight} />
      ) : (
        shadowMode !== "none" && <DeviceShadow mode={shadowMode} scale={scale} groundY={groundY} />
      )}
      {/* Float rides an inner group so the ground shadow stays put. */}
      <group
        position={[0, floatY, 0]}
        rotation={[
          rotationDeg[0] * DEG2RAD + introRotX,
          rotationDeg[1] * DEG2RAD + spinY + introRotY,
          rotationDeg[2] * DEG2RAD,
        ]}
        scale={introScale}
      >
        <group scale={scale * fit}>
          <primitive object={root} />
        </group>
      </group>
      {media?.kind === "video" && (
        <ScreenVideo
          src={media.src}
          startMs={media.startMs ?? 0}
          material={screenMaterial}
          screens={screens}
          screenAspect={activeSpec.screen.aspect}
        />
      )}
      {media?.kind === "image" && (
        <ScreenImage
          src={media.src}
          material={screenMaterial}
          screens={screens}
          screenAspect={activeSpec.screen.aspect}
          projectId={projectId}
        />
      )}
    </group>
  );
}

/** Host-side devices for scenes whose TSX never wires `useSceneDevices` (mounted by App's SceneHost, never scene TSX): reads the doc directly so it can't register as a consumer itself, and mirrors the device template's portrait scale so Add device looks the same on any scene kind. */
export function DevicesFallback() {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  const consumed = useSceneConsumesDevices(sceneIndex);
  const format = useFormat();
  const portrait = format.aspect < 1;
  const devices = doc?.devices ?? [];
  if (consumed || devices.length === 0) return null;
  return (
    <>
      {devices.map((d) => (
        <Device
          key={d.id}
          {...(d as SceneDeviceProps)}
          placement={{
            ...d.placement,
            scale: (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92),
          }}
        />
      ))}
    </>
  );
}

// Warm drei's cache so the first render has geometry ready; the export preamble awaits `preloadCatalogModels()` for the hard barrier.
{
  const urls = new Set(Object.values(DEVICE_CATALOG).map((s) => s.glbUrl));
  for (const url of urls) useGLTF.preload(url);
}
