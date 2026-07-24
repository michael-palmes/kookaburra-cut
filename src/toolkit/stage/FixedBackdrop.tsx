import { useTexture } from "@react-three/drei";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  GLSL3,
  type Group,
  type Material,
  Matrix4,
  type Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from "three";
import { useClipTexture } from "../../engine/clipTexture";
import { useClockStore } from "../../engine/clock";
import { isExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext, SceneDocContext } from "../../engine/sceneContext";
import { useEditorStore } from "../../store/editorStore";
import { useTheme } from "../../theme";
import type { ThemeBackground } from "../../theme/tokens";
import { preparingVideoTexture } from "../media/preparingTexture";
import {
  bundledBackdropUrl,
  getBundledBackdropTexture,
  gradientTexture,
  preloadBundledBackdrops,
  useExactMaterial,
} from "./backdrops";
import {
  FIXED_BG_DISTANCE,
  FIXED_BG_RENDER_ORDER,
  fixedContainScale,
  fixedCoverCrop,
  fixedFitQuadSize,
  fixedParallaxOffset,
  fixedQuadSize,
} from "./fixedMath";
import { SHADER_BACKGROUNDS } from "./shaders";
import { getShaderNoiseTexture } from "./shaders/noiseTexture";
import { shaderBackgroundVertex } from "./shaders/vertex";
import { wrapDisplayDomainFragment } from "./shaders/wrap";

/** The fixed (camera-locked, frame-filling) background, mounted for every scene by the scene host regardless of staging: its quad lives in the scene's host group like any other content but its `matrixWorld` is rewritten from the live camera in `onBeforeRender` (deterministic since camera state is a pure function of the clock), and it draws first via `renderOrder = FIXED_BG_RENDER_ORDER` with `depthTest/depthWrite: false` so every world object paints over it regardless of z; all placement/crop/parallax math is golden-pinned in `fixedMath.ts` (export contract). */

interface CropWindow {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const FULL_WINDOW: CropWindow = { u0: 0, v0: 0, u1: 1, v1: 1 };

/** A unit quad centred on the origin with the crop window baked into PER-INSTANCE UVs (never `texture.repeat/offset`, since the bundled/drei texture caches are shared with the world-space ImagePlane, which cover-crops the same texture objects that way). */
function fixedQuadGeometry(crop: CropWindow): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]),
      3,
    ),
  );
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
  );
  geometry.setAttribute(
    "uv",
    new BufferAttribute(
      new Float32Array([crop.u0, crop.v0, crop.u1, crop.v0, crop.u0, crop.v1, crop.u1, crop.v1]),
      2,
    ),
  );
  geometry.setIndex([0, 1, 2, 1, 3, 2]);
  return geometry;
}

function FixedQuad({
  material,
  crop = FULL_WINDOW,
  parallax = 0,
  fitScale,
  renderOrder = FIXED_BG_RENDER_ORDER,
  beforeRender,
}: {
  material: Material;
  crop?: CropWindow;
  parallax?: number;
  /** Contain (letterbox) axis scales: present = the quad is sized to fit WHOLLY inside the frame (fixedFitQuadSize), absent = the fill path's frustum-filling size (fixedQuadSize). */
  fitScale?: { x: number; y: number };
  /** Draw order among the fixed layers; the fit path stacks its video quad one above the bars quad. */
  renderOrder?: number;
  /** Per-draw uniform writes (the shader fill's clock read and target probe); runs before the matrix rewrite. */
  beforeRender?: (renderer: WebGLRenderer) => void;
}) {
  // `crop` identities are stable (a module constant or a useMemo in FixedImageMesh).
  const geometry = useMemo(() => fixedQuadGeometry(crop), [crop]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const meshRef = useRef<Mesh>(null);
  const warnedFar = useRef(false);

  const onBeforeRender = useMemo(() => {
    const translate = new Matrix4();
    const scale = new Matrix4();
    const anchor = new Vector3();
    return (renderer: unknown, _scene: unknown, camera: unknown) => {
      beforeRender?.(renderer as WebGLRenderer);
      const mesh = meshRef.current;
      const cam = camera as PerspectiveCamera;
      if (!mesh || !cam.isPerspectiveCamera) return;
      if (import.meta.env.DEV && cam.far <= FIXED_BG_DISTANCE && !warnedFar.current) {
        warnedFar.current = true;
        console.warn(`[stage] camera far (${cam.far}) ≤ FIXED_BG_DISTANCE — background clipped`);
      }
      let ndcX = 0;
      let ndcY = 0;
      let inFront = true;
      if (parallax > 0) {
        // The content anchor (world origin) through the current camera: its NDC IS the content's screen displacement (base pose → (0,0)); view space looks down −z, so an anchor behind the camera (pathological orbit) holds the drift at 0.
        anchor.set(0, 0, 0).applyMatrix4(cam.matrixWorldInverse);
        inFront = anchor.z < 0;
        if (inFront) {
          anchor.applyMatrix4(cam.projectionMatrix); // includes the perspective divide
          ndcX = anchor.x;
          ndcY = anchor.y;
        }
      }
      const size = fitScale
        ? fixedFitQuadSize(cam.fov, cam.aspect, fitScale)
        : fixedQuadSize(cam.fov, cam.aspect, parallax);
      const off = fixedParallaxOffset(cam.fov, cam.aspect, parallax, ndcX, ndcY, inFront);
      translate.makeTranslation(off.x, off.y, -FIXED_BG_DISTANCE);
      scale.makeScale(size.width, size.height, 1);
      // Written per render call, after the graph's updateMatrixWorld; always wins.
      mesh.matrixWorld.copy(cam.matrixWorld).multiply(translate).multiply(scale);
    };
  }, [parallax, fitScale, beforeRender]);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      renderOrder={renderOrder}
      frustumCulled={false}
      matrixAutoUpdate={false}
      onBeforeRender={onBeforeRender}
    />
  );
}

function configureFixed(m: MeshBasicMaterial) {
  m.depthTest = false;
  m.depthWrite = false;
}

function FixedColor({ spec }: { spec: Extract<ThemeBackground, { type: "color" }> }) {
  const material = useExactMaterial(
    (m) => {
      configureFixed(m);
      m.color.set(spec.color);
    },
    [spec.color],
  );
  return <FixedQuad material={material} parallax={spec.parallax ?? 0} />;
}

function FixedGradient({ spec }: { spec: Extract<ThemeBackground, { type: "gradient" }> }) {
  const theme = useTheme();
  // An inline spec (the gradient picker's presets/customs) wins; a name resolves through the scene's theme.
  const gradient = spec.spec ?? (spec.gradient ? theme.gradients?.[spec.gradient] : undefined);
  const texture = useMemo(() => (gradient ? gradientTexture(gradient) : null), [gradient]);
  useLayoutEffect(() => () => texture?.dispose(), [texture]);
  const material = useExactMaterial(
    (m) => {
      configureFixed(m);
      m.map = texture;
    },
    [texture],
  );
  if (!gradient) {
    console.warn(`[stage] background gradient "${spec.gradient ?? "?"}" not found in the theme`);
    return null;
  }
  // The square raster stretches to the frame (the GradientPlane precedent; effective angle is per-aspect, documented).
  return <FixedQuad material={material} parallax={spec.parallax ?? 0} />;
}

/** The shared image path: clone + cover-crop UVs (both bundled and project sources). */
function FixedImageMesh({
  source,
  spec,
}: {
  source: Texture;
  spec: Extract<ThemeBackground, { type: "image" }>;
}) {
  const { aspect } = useFormat();
  // CLONE the cached texture: the world-space ImagePlane cover-crops the same shared texture object via repeat/offset, and the fixed path must neither see nor write that; the clone resets the transform explicitly so mount order can never matter.
  const texture = useMemo(() => {
    const t = source.clone();
    t.colorSpace = SRGBColorSpace;
    t.repeat.set(1, 1);
    t.offset.set(0, 0);
    t.needsUpdate = true;
    return t;
  }, [source]);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  const img = source.image as { width: number; height: number } | undefined;
  const crop = useMemo(
    () => (img ? fixedCoverCrop(img.width / img.height, aspect) : FULL_WINDOW),
    [img, aspect],
  );
  const material = useExactMaterial(
    (m) => {
      configureFixed(m);
      m.map = texture;
    },
    [texture],
  );
  return <FixedQuad material={material} crop={crop} parallax={spec.parallax ?? 0} />;
}

/** Bundled (`kookaburra:`) sources read the awaited module cache, NO suspense (see preloadBundledBackdrops); self-heals on load, unreachable at export/capture. */
function FixedImageBundled({
  url,
  spec,
}: {
  url: string;
  spec: Extract<ThemeBackground, { type: "image" }>;
}) {
  const [, bump] = useState(0);
  const texture = getBundledBackdropTexture(url);
  useEffect(() => {
    if (!texture) void preloadBundledBackdrops().then(() => bump((n) => n + 1));
  }, [texture]);
  if (!texture) return null;
  return <FixedImageMesh source={texture} spec={spec} />;
}

/** Project-relative sources keep the suspense load; covered at export by the scene-host commit barrier + preloadProjectImages, like the world image backdrop. */
function FixedImageLoaded({
  url,
  spec,
}: {
  url: string;
  spec: Extract<ThemeBackground, { type: "image" }>;
}) {
  const texture = useTexture(url) as Texture;
  return <FixedImageMesh source={texture} spec={spec} />;
}

function FixedImage({ spec }: { spec: Extract<ThemeBackground, { type: "image" }> }) {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  if (spec.src.startsWith("kookaburra:")) {
    const bundled = bundledBackdropUrl(spec.src.slice("kookaburra:".length));
    if (!bundled) {
      console.warn(`[stage] bundled background "${spec.src}" not found — no background`);
      return null;
    }
    return <FixedImageBundled url={bundled} spec={spec} />;
  }
  let url: string | null = null;
  try {
    url = resolveAssetUrl(projectId, spec.src);
  } catch (e) {
    console.warn(`[stage] background image "${spec.src}" unresolved:`, e);
  }
  if (!url) return null;
  return <FixedImageLoaded url={url} spec={spec} />;
}

/** Video fill: the clip frame pipeline on the fixed quad, streaming through the SHARED `useClipTexture` binding so `awaitVideoFramesReady` covers this consumer identically to VideoClip/Device; loops by default (`loop: false` holds the last frame, the VideoClip edge semantics), and while extraction is pending the group stays invisible so the scene shows its resolved underlay rather than a black pop (unreachable during export/capture). Frame textures are SHARED (never mutate them); cover-crop rides the quad's per-instance UVs like the image path. */
function FixedVideo({ spec }: { spec: Extract<ThemeBackground, { type: "video" }> }) {
  const { aspect } = useFormat();
  const theme = useTheme();
  const isFit = spec.fit === "fit";
  const groupRef = useRef<Group>(null);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ side: DoubleSide });
    m.toneMapped = false;
    configureFixed(m);
    return m;
  }, []);
  useLayoutEffect(() => () => material.dispose(), [material]);
  // The letterbox bars: a full-frame quad in the theme background colour behind the contained video (fit only; the fill path never mounts it).
  const barsMaterial = useExactMaterial(
    (m) => {
      configureFixed(m);
      m.color.set(theme.colors.background);
    },
    [theme.colors.background],
  );

  const onPending = useCallback(() => {
    if (groupRef.current) groupRef.current.visible = false;
  }, []);
  const onBound = useCallback(() => {
    if (groupRef.current) groupRef.current.visible = true;
  }, []);

  const { info, error } = useClipTexture({
    src: spec.src,
    startMs: 0,
    loop: spec.loop !== false,
    material,
    readyObjectRef: groupRef,
    onPending,
    onBound,
  });

  const crop = useMemo(
    () => (!isFit && info ? fixedCoverCrop(info.width / info.height, aspect) : FULL_WINDOW),
    [isFit, info, aspect],
  );
  const containScale = useMemo(
    () => (isFit && info ? fixedContainScale(info.width / info.height, aspect) : undefined),
    [isFit, info, aspect],
  );

  // While frames extract, a second fixed quad shows the shared "Preparing video…" card instead of dropping to the underlay, PREVIEW ONLY: `isExporting()` stands it down and the export barriers mean no captured frame can sample it (the VideoClip stand-in pattern).
  const pendingMaterial = useExactMaterial(
    (m) => {
      configureFixed(m);
      m.map = preparingVideoTexture(aspect, true);
    },
    [aspect],
  );

  if (error) {
    console.warn(`[stage] background video "${spec.src}" failed to extract: ${error}`);
    return null;
  }
  return (
    <>
      <group ref={groupRef} visible={false}>
        {isFit && <FixedQuad material={barsMaterial} parallax={spec.parallax ?? 0} />}
        <FixedQuad
          material={material}
          crop={crop}
          parallax={spec.parallax ?? 0}
          fitScale={containScale}
          renderOrder={isFit ? FIXED_BG_RENDER_ORDER + 1 : undefined}
        />
      </group>
      {!info && !isExporting() && <FixedQuad material={pendingMaterial} />}
    </>
  );
}

/** Hex → plain 0-1 sRGB RGBA (the paper-design convention: shaders mix and write display-domain values raw, no linear conversion, matching the exact-colour discipline). */
function hexToRgba(hex: string): [number, number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b, 1];
}

/** Animated GLSL fill: the vendored paper-design effect on the fixed quad. `u_time` reads the ABSOLUTE project clock per draw (scene hosts stay mounted, so the pattern runs continuously across cuts) scaled by `speed`; every other uniform is static per spec. Unknown shader ids degrade to nothing (the parser is schema-light by design). */
function FixedShader({ spec }: { spec: Extract<ThemeBackground, { type: "shader" }> }) {
  const format = useFormat();
  const def = SHADER_BACKGROUNDS[spec.shader];
  const speed = spec.speed ?? 1;
  // Spec identity via JSON: sidecar writes replace the whole background object, so stringify is a stable memo key that survives unrelated doc patches; the memo re-parses it so its dependencies stay honest.
  const specKey = JSON.stringify(spec);
  const material = useMemo(() => {
    if (!def) return null;
    const s = JSON.parse(specKey) as Extract<ThemeBackground, { type: "shader" }>;
    const named = def.colorSlots.map((slot, i) => s.colors?.[i] ?? slot.fallback);
    const extras = (s.colors ?? []).slice(named.length, def.maxColors ?? named.length);
    const colors = [...named, ...extras].map(hexToRgba);
    const params: Record<string, number> = {};
    for (const [key, p] of Object.entries(def.params)) {
      params[key] = s.params?.[key] ?? p.default;
    }
    return new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: shaderBackgroundVertex,
      fragmentShader: wrapDisplayDomainFragment(def.fragment),
      uniforms: {
        ...def.uniforms(colors, params),
        // The shared randomizer texture builds synchronously (DataTexture), so no export barrier is needed.
        ...(def.noise ? { u_noiseTexture: { value: getShaderNoiseTexture() } } : {}),
        u_time: { value: 0 },
        u_linearOut: { value: 0 },
        // Pinned to the EXPORT format pixels, never the live canvas, so preview and export lay the pattern out identically.
        u_resolution: { value: new Vector2(format.width, format.height) },
        u_scale: { value: s.scale ?? 1 },
        u_rotation: { value: 0 },
        u_offsetX: { value: 0 },
        u_offsetY: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }, [def, specKey, format.width, format.height]);
  useLayoutEffect(() => () => material?.dispose(), [material]);
  const beforeRender = useCallback(
    (renderer: WebGLRenderer) => {
      if (!material) return;
      material.uniforms.u_time.value = (useClockStore.getState().currentMs / 1000) * speed;
      // Colour-managed (hardware sRGB) targets re-encode on store, so hand them linear light; the canvas keeps the raw display-domain bytes.
      const target = renderer.getRenderTarget();
      material.uniforms.u_linearOut.value =
        target && target.texture.colorSpace === SRGBColorSpace ? 1 : 0;
    },
    [material, speed],
  );
  if (!def) {
    console.warn(`[stage] shader background "${spec.shader}" not found — no background`);
    return null;
  }
  if (!material) return null;
  return (
    <FixedQuad material={material} parallax={spec.parallax ?? 0} beforeRender={beforeRender} />
  );
}

/** The scene's fixed background, switched on the resolved spec. `none` renders nothing. */
export function FixedBackdrop({ spec }: { spec: ThemeBackground }) {
  switch (spec.type) {
    case "color":
      return <FixedColor spec={spec} />;
    case "gradient":
      return <FixedGradient spec={spec} />;
    case "image":
      return <FixedImage spec={spec} />;
    case "video":
      return <FixedVideo spec={spec} />;
    case "shader":
      return <FixedShader spec={spec} />;
    default:
      return null;
  }
}

/** The per-scene fixed-background mount: resolves `doc.background ?? theme.background` and mounts `FixedBackdrop` when a spec is present, rendered by the scene HOST inside every `<SceneHost>` group so the inspector's Background surface works on every scene, with or without an authored `<SceneStage>`; absent spec = no mesh (legacy bytes structurally safe), and since the quad's `matrixWorld` is camera-derived per draw and its draw order is `renderOrder`-driven, the mount point inside the scene group carries no pixel meaning. */
export function SceneBackground() {
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const background = doc?.background ?? theme.background;
  if (!background || background.type === "none") return null;
  return <FixedBackdrop spec={background} />;
}
