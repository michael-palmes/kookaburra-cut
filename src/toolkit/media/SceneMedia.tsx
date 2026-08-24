import { useTexture } from "@react-three/drei";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DoubleSide,
  FrontSide,
  type Group,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  RGBADepthPacking,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
} from "three";
import { useClipTexture } from "../../engine/clipTexture";
import { isExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import { frameLayerRenderOrder } from "../../engine/frameLayerOrder";
import { useGizmoSectionOpen } from "../../engine/gizmoSections";
import { useImageOverlayPreview, useImageStagePreview } from "../../engine/imageEditStore";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext, SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useSceneMedia } from "../../engine/sceneDoc";
import type {
  SceneDocMediaSpec,
  SceneImageOverlayPlacement,
  SceneImageStagePlacement,
  SceneMediaWindow,
} from "../../engine/sceneDocSchema";
import {
  resolveSceneDocMedia,
  type SceneImageMotionSample,
  sampleSceneMediaMotion,
  sceneMediaFamily,
  sceneMediaInFrame,
  sceneMediaInWorld,
  sceneMediaUsesWindowPath,
} from "../../engine/sceneMedia";
import { useSceneConsumesMedia } from "../../engine/sceneMediaRegistry";
import {
  type NormalizedVideoWindowShadow,
  type NormalizedWindowChrome,
  normalizeWindowChrome,
  recordingCrop,
} from "../../engine/sceneVideoWindow";
import { useTimeline } from "../../engine/timeline";
import { assetVersionKey, useAssetVersionStore } from "../../store/assetVersionStore";
import { useEditorStore } from "../../store/editorStore";
import { useStageMapShadows } from "../stage/context";
import type { FormatInfo } from "../types";
import { AssetBoundary } from "./AssetBoundary";
import {
  applyCardMask,
  type CardUniforms,
  cardUniforms,
  SHADOW_FRAG,
  SHADOW_VERT,
} from "./LayeredScreenshot";
import { preparingVideoTexture } from "./preparingTexture";
import { StageImageGizmo, StageImageOutline } from "./StageImageGizmo";

const DEG2RAD = Math.PI / 180;
const IMAGE_ALPHA_TEST = 1 / 255;
/** The shadow quad sits just behind the window inside the moving group, so it tracks the window's motion. */
const SHADOW_BEHIND = 0.12;
/** Last-resort aspect before a clip's intrinsics arrive; the entry's recorded `video.aspect` seeds first, so a window keeps its size across remounts and media swaps (exports have intrinsics by frame 0 behind the extract barrier). */
const DEFAULT_CLIP_ASPECT = 16 / 9;

export interface StageImageTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  size: number;
  opacity: number;
}

export interface OverlayImageTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  width: number;
  height: number;
  opacity: number;
  renderOrder: number;
}

/** A windowed entry's group: window chrome carries a drop shadow and rides its motion as one, so the group moves and the plane keeps its own size (the legacy videoWindow composition). */
export interface WindowMediaTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  /** The box the plane fits inside, in the group's units; a null height leaves the width free (the Stage has no box to fit into). */
  box: { width: number; height: number | null };
}

interface Rect {
  width: number;
  height: number;
}

/** The recording-mode source crop as a UV transform (v = 0 is the frame's bottom, the clip pipeline's pre-flipped upload). */
interface WindowUv {
  scale: [number, number];
  offset: [number, number];
}

export function sampleRenderedSceneMediaMotion(
  entry: SceneDocMediaSpec,
  localMs: number,
  editorOwnsMedia: boolean,
): SceneImageMotionSample {
  return sampleSceneMediaMotion(
    entry.kind,
    editorOwnsMedia ? undefined : entry.motion,
    entry.host,
    localMs,
  );
}

export function shouldNeutraliseSceneMediaMotion(
  sectionOpen: boolean,
  exporting: boolean,
): boolean {
  return sectionOpen && !exporting;
}

export function createStageImageShadowMaterials(texture: Texture): {
  depth: MeshDepthMaterial;
  distance: MeshDistanceMaterial;
} {
  return {
    depth: new MeshDepthMaterial({
      depthPacking: RGBADepthPacking,
      map: texture,
      alphaTest: IMAGE_ALPHA_TEST,
      side: DoubleSide,
    }),
    distance: new MeshDistanceMaterial({
      map: texture,
      alphaTest: IMAGE_ALPHA_TEST,
      side: DoubleSide,
    }),
  };
}

export function resolveStageImageTransform(
  placement: SceneImageStagePlacement,
  motion: SceneImageMotionSample,
): StageImageTransform {
  return {
    position: [
      placement.position[0] + motion.position[0],
      placement.position[1] + motion.position[1],
      placement.position[2] + motion.position[2],
    ],
    rotation: [
      (placement.rotationDeg[0] + motion.rotationDeg[0]) * DEG2RAD,
      (placement.rotationDeg[1] + motion.rotationDeg[1]) * DEG2RAD,
      (placement.rotationDeg[2] + motion.rotationDeg[2]) * DEG2RAD,
    ],
    size: placement.size * motion.scale,
    opacity: motion.opacity,
  };
}

export function resolveOverlayImageTransform(
  placement: SceneImageOverlayPlacement,
  motion: SceneImageMotionSample,
  format: FormatInfo,
  sourceAspect: number,
  stackOrder: number,
): OverlayImageTransform {
  const width = placement.size * format.frame.width * motion.scale;
  return {
    position: [
      ((placement.position[0] + motion.position[0]) * format.frame.width) / 2,
      ((placement.position[1] + motion.position[1]) * format.frame.height) / 2,
      motion.position[2],
    ],
    rotation: [
      motion.rotationDeg[0] * DEG2RAD,
      motion.rotationDeg[1] * DEG2RAD,
      -(placement.rotationDeg + motion.rotationDeg[2]) * DEG2RAD,
    ],
    width,
    height: placement.shape === "circle" ? width : width / sourceAspect,
    opacity: motion.opacity,
    renderOrder: frameLayerRenderOrder(placement.layer, stackOrder),
  };
}

/** A windowed entry's world-space group, from whichever host placement is active: the Stage's world units, or the Window host's frame fractions resolved against the frame (which is what the video window has always done, its `offset`/`scale` being exactly those fractions, and why the window host needs no placement block of its own). */
export function resolveWindowMediaTransform(
  entry: SceneDocMediaSpec,
  motion: SceneImageMotionSample,
  format: FormatInfo,
): WindowMediaTransform {
  if (entry.host === "stage") {
    const placement = entry.stage;
    return {
      position: [
        placement.position[0] + motion.position[0],
        placement.position[1] + motion.position[1],
        placement.position[2] + motion.position[2],
      ],
      rotation: [
        (placement.rotationDeg[0] + motion.rotationDeg[0]) * DEG2RAD,
        (placement.rotationDeg[1] + motion.rotationDeg[1]) * DEG2RAD,
        (placement.rotationDeg[2] + motion.rotationDeg[2]) * DEG2RAD,
      ],
      scale: motion.scale,
      box: { width: placement.size, height: null },
    };
  }
  const placement = entry.overlay;
  return {
    position: [
      motion.position[0] + (placement.position[0] * format.frame.width) / 2,
      motion.position[1] + (placement.position[1] * format.frame.height) / 2,
      motion.position[2],
    ],
    rotation: [
      motion.rotationDeg[0] * DEG2RAD,
      motion.rotationDeg[1] * DEG2RAD,
      -(placement.rotationDeg + motion.rotationDeg[2]) * DEG2RAD,
    ],
    scale: motion.scale,
    box: {
      width: placement.size * format.frame.width,
      height: placement.size * format.frame.height,
    },
  };
}

export function resolveOverlayImageStackOrders(
  entries: readonly SceneDocMediaSpec[],
  orderStart: number,
): number[] {
  let fallback = entries.reduce(
    (next, entry) =>
      entry.overlay.stackOrder === undefined ? next : Math.max(next, entry.overlay.stackOrder + 1),
    orderStart,
  );
  return entries.map((entry) => entry.overlay.stackOrder ?? fallback++);
}

function sourceAspect(texture: Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 1;
  const height = image?.height ?? 1;
  return width > 0 && height > 0 ? width / height : 1;
}

/** A still's own pixel size, which the recording crop is measured in; null until the decode lands. */
function textureIntrinsics(texture: Texture): { width: number; height: number } | null {
  const image = texture.image as { width?: number; height?: number } | undefined;
  return image?.width && image.height ? { width: image.width, height: image.height } : null;
}

/** The still's loadable URL, or null for a clip (which the clip pipeline resolves from the project-relative src itself) and for anything unresolvable. */
function useSceneImageUrl(src: string | null): string | null {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((state) => state.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  const version = useAssetVersionStore((state) =>
    src === null ? 0 : (state.versions[assetVersionKey(projectId, src)] ?? 0),
  );
  if (src === null) return null;
  try {
    const url = resolveAssetUrl(projectId, src);
    return version > 0 ? `${url}?v=${version}` : url;
  } catch (error) {
    console.warn(`[image] "${src}" unresolved:`, error);
    return null;
  }
}

function useColourTexture(url: string): Texture {
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  return texture;
}

function applyCircleMask(material: MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying vec2 vSceneImageUv;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vSceneImageUv = uv;",
    );
    shader.fragmentShader = `varying vec2 vSceneImageUv;\n${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      `#include <opaque_fragment>
      float sceneImageD = length(vSceneImageUv - 0.5) - 0.5;
      gl_FragColor.a *= 1.0 - smoothstep(-0.01, 0.01, sceneImageD);`,
    );
  };
  material.customProgramCacheKey = () => "kookaburra-scene-image-circle-v1";
}

// ── Window chrome (rounded mask, recording crop, border, analytic drop shadow) ─

interface WindowUvUniforms {
  uVwUvScale: { value: Vector2 };
  uVwUvOffset: { value: Vector2 };
}

const windowUvUniforms = (): WindowUvUniforms => ({
  uVwUvScale: { value: new Vector2(1, 1) },
  uVwUvOffset: { value: new Vector2(0, 0) },
});

const WINDOW_UV_DEFS = /* glsl */ `
uniform vec2 uVwUvScale;
uniform vec2 uVwUvOffset;
`;

// Crop-aware map sampling; the identity transform samples exactly like the stock chunk, keeping non-recording windows byte-identical.
const WINDOW_MAP_FRAGMENT = /* glsl */ `#ifdef USE_MAP
	diffuseColor *= texture2D( map, vMapUv * uVwUvScale + uVwUvOffset );
#endif`;

/** The card mask plus the recording crop's UV remap, under a window-only program key. */
function applyWindowMask(
  material: MeshBasicMaterial,
  card: CardUniforms,
  uv: WindowUvUniforms,
): void {
  applyCardMask(material, card);
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer);
    Object.assign(shader.uniforms, uv);
    shader.fragmentShader =
      WINDOW_UV_DEFS +
      shader.fragmentShader.replace("#include <map_fragment>", WINDOW_MAP_FRAGMENT);
  };
  material.customProgramCacheKey = () => "kookaburra-vw-card-v1";
}

interface WindowGeometry {
  rect: Rect;
  radiusFraction: number;
  uv: WindowUv | null;
}

interface WindowChromeSurface {
  /** The aspect the visible content shows once cropped, or null when nothing is cropped. */
  cropAspect: number | null;
  radiusFraction: number;
  uv: WindowUv | null;
}

/** What the chrome takes from the source pixels, shared by every chromed plane: the recording crop's UV remap, the aspect that crop leaves, and the radius the mask draws at (the macOS preset follows the capture's true pixel radius under `recording`). */
export function windowChromeSurface(
  chrome: NormalizedWindowChrome,
  intrinsics: { width: number; height: number } | null,
): WindowChromeSurface {
  const crop =
    chrome.recording && intrinsics ? recordingCrop(intrinsics.width, intrinsics.height) : null;
  return {
    cropAspect: crop ? crop.width / crop.height : null,
    radiusFraction:
      crop && chrome.radiusTracksRecording ? crop.radiusFraction : chrome.radiusFraction,
    uv:
      crop && intrinsics
        ? {
            scale: [crop.width / intrinsics.width, crop.height / intrinsics.height],
            offset: [
              crop.x / intrinsics.width,
              (intrinsics.height - crop.y - crop.height) / intrinsics.height,
            ],
          }
        : null,
  };
}

/** The aspect a clip's plane draws at, whichever layer draws it: the recording crop's, else the clip's own intrinsics, else the size the doc recorded at pick time (which holds the plane steady until the extract lands; an export has intrinsics by frame 0 behind the extract barrier). */
export function resolveClipAspect(
  cropAspect: number | null,
  intrinsics: { width: number; height: number } | null,
  authoredAspect: number | null,
): number {
  if (cropAspect !== null) return cropAspect;
  if (intrinsics && intrinsics.height > 0) return intrinsics.width / intrinsics.height;
  return authoredAspect ?? DEFAULT_CLIP_ASPECT;
}

/** The plane a windowed clip draws on: a contain fit inside the size box, at the cropped aspect once the source's intrinsics arrive. */
export function windowGeometry(
  box: { width: number; height: number | null },
  chrome: NormalizedWindowChrome,
  intrinsics: { width: number; height: number } | null,
  authoredAspect: number | null,
): WindowGeometry {
  const surface = windowChromeSurface(chrome, intrinsics);
  const aspect = resolveClipAspect(surface.cropAspect, intrinsics, authoredAspect);
  const width = box.height === null ? box.width : Math.min(box.width, box.height * aspect);
  return {
    rect: { width, height: width / aspect },
    radiusFraction: surface.radiusFraction,
    uv: surface.uv,
  };
}

/** The window's drop shadow (analytic, reuses the LayeredScreenshot shaders). On the frame layer it takes its plane's own render order, where the shared order plus its greater depth draws it first. */
function WindowShadow({
  rect,
  shadow,
  radiusFraction,
  renderOrder = 0,
}: {
  rect: Rect;
  shadow: NormalizedVideoWindowShadow;
  radiusFraction: number;
  renderOrder?: number;
}) {
  const short = Math.min(rect.width, rect.height);
  const blur = shadow.blur * short;
  const width = rect.width + blur * 2;
  const height = rect.height + blur * 2;
  const radius = radiusFraction * short;
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        uniforms: {
          uSize: { value: new Vector2(width, height) },
          uHalf: { value: new Vector2(rect.width / 2, rect.height / 2) },
          uRadius: { value: radius },
          uBlur: { value: blur },
          uOpacity: { value: shadow.opacity },
        },
      }),
    [width, height, rect.width, rect.height, radius, blur, shadow.opacity],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);
  return (
    <mesh
      position={[shadow.offset[0] * short, shadow.offset[1] * short, -SHADOW_BEHIND]}
      material={material}
      renderOrder={renderOrder}
    >
      <planeGeometry args={[width, height]} />
    </mesh>
  );
}

function applyWindowUniforms(
  card: CardUniforms,
  uvUniforms: WindowUvUniforms,
  geometry: WindowGeometry,
  chrome: NormalizedWindowChrome,
): void {
  const { rect, radiusFraction, uv } = geometry;
  const short = Math.min(rect.width, rect.height);
  card.uCardSize.value.set(rect.width, rect.height);
  card.uCardRadius.value = radiusFraction * short;
  card.uCardStrokeColor.value.set(chrome.border.color);
  card.uCardStrokeWidth.value = chrome.border.width * short;
  card.uCardStrokeAlpha.value = chrome.border.enabled ? chrome.border.opacity : 0;
  uvUniforms.uVwUvScale.value.set(uv?.scale[0] ?? 1, uv?.scale[1] ?? 1);
  uvUniforms.uVwUvOffset.value.set(uv?.offset[0] ?? 0, uv?.offset[1] ?? 0);
}

/** `side` is the one knob a chromed still needs: its plane can be turned on Stage, where the clip window never is. */
function useWindowMaterial(
  texture: Texture | null,
  side: MeshBasicMaterial["side"] = FrontSide,
): {
  material: MeshBasicMaterial;
  card: CardUniforms;
  uv: WindowUvUniforms;
} {
  const card = useMemo(() => cardUniforms(), []);
  const uv = useMemo(() => windowUvUniforms(), []);
  const material = useMemo(() => {
    const next = new MeshBasicMaterial({ transparent: true, depthWrite: false, side });
    if (texture) next.map = texture;
    next.toneMapped = false;
    applyWindowMask(next, card, uv);
    return next;
  }, [card, side, texture, uv]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  return { material, card, uv };
}

// ── Clip-backed planes ────────────────────────────────────────────────────────

/** Drives `material` from the deterministic clip pipeline and gates the plane on the first bound frame; the readiness node lives in this component's own subtree (the useClipTexture contract), so no untextured plane can paint. */
function ClipPlane({
  src,
  startMs,
  loop,
  material,
  rect,
  renderOrder,
  onIntrinsics,
}: {
  src: string;
  startMs: number;
  loop: boolean;
  material: MeshBasicMaterial;
  rect: Rect;
  renderOrder?: number;
  onIntrinsics: (width: number, height: number) => void;
}) {
  const readyRef = useRef<Group>(null);
  const contentRef = useRef<Group>(null);
  const onPending = useCallback(() => {
    if (contentRef.current) contentRef.current.visible = false;
  }, []);
  const onBound = useCallback(() => {
    if (contentRef.current) contentRef.current.visible = true;
  }, []);
  const { info } = useClipTexture({
    src,
    startMs,
    loop,
    material,
    readyObjectRef: readyRef,
    onPending,
    onBound,
  });
  useLayoutEffect(() => {
    if (info && info.height > 0) onIntrinsics(info.width, info.height);
  }, [info, onIntrinsics]);
  return (
    <group ref={readyRef}>
      <group ref={contentRef} visible={false}>
        <mesh material={material} renderOrder={renderOrder}>
          <planeGeometry args={[rect.width, rect.height]} />
        </mesh>
      </group>
      {/* While frames extract, the shared "Preparing video…" card fills the plane, PREVIEW ONLY: `isExporting()` stands it down and the export barriers mean no captured frame can sample it anyway. */}
      {!info && !isExporting() && (
        <mesh renderOrder={renderOrder}>
          <planeGeometry args={[rect.width, rect.height]} />
          <meshBasicMaterial
            map={preparingVideoTexture(rect.width / rect.height, true)}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

function useClipIntrinsics(): [
  { width: number; height: number } | null,
  (width: number, height: number) => void,
] {
  const [intrinsics, setIntrinsics] = useState<{ width: number; height: number } | null>(null);
  const onIntrinsics = useCallback(
    (width: number, height: number) =>
      setIntrinsics((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      ),
    [],
  );
  return [intrinsics, onIntrinsics];
}

// ── Windowed entries (either kind) ────────────────────────────────────────────

/** The selection outline for a windowed entry, sized from the resolved plane; only the Stage host carries 3D chrome, the Overlay host is edited through the 2D gizmo. */
function WindowOutline({
  entry,
  sceneIndex,
  rect,
}: {
  entry: SceneDocMediaSpec;
  sceneIndex: number;
  rect: Rect;
}) {
  if (entry.host !== "stage") return null;
  return (
    <StageImageOutline
      imageId={entry.id}
      sceneIndex={sceneIndex}
      localSize={[rect.width, rect.height]}
    />
  );
}

function WindowVideoSurface({
  entry,
  sceneIndex,
  box,
  chrome,
}: {
  entry: SceneDocMediaSpec;
  sceneIndex: number;
  box: { width: number; height: number | null };
  chrome: NormalizedWindowChrome;
}) {
  const [intrinsics, onIntrinsics] = useClipIntrinsics();
  const geometry = windowGeometry(box, chrome, intrinsics, entry.video?.aspect ?? null);
  const { material, card, uv } = useWindowMaterial(null);
  applyWindowUniforms(card, uv, geometry, chrome);
  return (
    <>
      <WindowShadow
        rect={geometry.rect}
        shadow={chrome.shadow}
        radiusFraction={geometry.radiusFraction}
      />
      <ClipPlane
        src={entry.src}
        startMs={entry.video?.startMs ?? 0}
        loop={entry.video?.loop === true}
        material={material}
        rect={geometry.rect}
        onIntrinsics={onIntrinsics}
      />
      <WindowOutline entry={entry} sceneIndex={sceneIndex} rect={geometry.rect} />
    </>
  );
}

/** A clip drawn through the window path with no chrome authored: a bare sharp-cornered plane, same contain sizing. The blur stays non-zero so the shadow shader's smoothstep keeps a band, invisible at zero opacity. */
const BARE_WINDOW_CHROME: SceneMediaWindow = {
  radius: "sharp",
  border: { enabled: false, color: "#ffffff", width: 0, opacity: 0 },
  shadow: { opacity: 0, blur: 0.14, offset: [0, 0] },
};

function WindowMedia({ entry }: { entry: SceneDocMediaSpec }) {
  const context = useSceneContext();
  const sceneIndex = context?.index ?? -1;
  const exporting = isExporting();
  const editable = context?.side === undefined && !exporting;
  const sectionOpen = useGizmoSectionOpen("media");
  const stagePreview = useImageStagePreview(
    sceneIndex,
    entry.id,
    editable && entry.host === "stage",
  );
  const overlayPreview = useImageOverlayPreview(
    sceneIndex,
    entry.id,
    editable && entry.host !== "stage",
  );
  const { localMs } = useTimeline();
  const format = useFormat();
  const chrome = useMemo(
    () => normalizeWindowChrome(entry.window ?? BARE_WINDOW_CHROME),
    [entry.window],
  );
  const placed: SceneDocMediaSpec = {
    ...entry,
    stage: stagePreview ?? entry.stage,
    overlay: overlayPreview ?? entry.overlay,
  };
  const transform = resolveWindowMediaTransform(
    placed,
    sampleRenderedSceneMediaMotion(
      entry,
      localMs,
      shouldNeutraliseSceneMediaMotion(sectionOpen, exporting),
    ),
    format,
  );
  return (
    <>
      <group position={transform.position} rotation={transform.rotation} scale={transform.scale}>
        <WindowVideoSurface
          entry={entry}
          sceneIndex={sceneIndex}
          box={transform.box}
          chrome={chrome}
        />
      </group>
      {entry.host === "stage" && (
        <StageImageGizmo
          imageId={entry.id}
          sceneIndex={sceneIndex}
          committed={entry.stage}
          windowed
        />
      )}
    </>
  );
}

// ── Stage-hosted entries ──────────────────────────────────────────────────────

function StageMedia({ entry, mapShadows }: { entry: SceneDocMediaSpec; mapShadows: boolean }) {
  const context = useSceneContext();
  const sceneIndex = context?.index ?? -1;
  const exporting = isExporting();
  const editable = context?.side === undefined && !exporting;
  const sectionOpen = useGizmoSectionOpen("media");
  const preview = useImageStagePreview(sceneIndex, entry.id, editable);
  const { localMs } = useTimeline();
  const url = useSceneImageUrl(entry.kind === "image" ? entry.src : null);
  const motion = sampleRenderedSceneMediaMotion(
    entry,
    localMs,
    shouldNeutraliseSceneMediaMotion(sectionOpen, exporting),
  );
  const placement = preview ?? entry.stage;
  if (entry.kind === "video") {
    return (
      <StageVideo entry={entry} placement={placement} motion={motion} sceneIndex={sceneIndex} />
    );
  }
  if (!url) return null;
  const castShadow = mapShadows && entry.castShadow === true;
  return (
    <AssetBoundary key={url} label={entry.src}>
      {entry.window ? (
        <ChromedStageImage
          entry={entry}
          url={url}
          placement={placement}
          motion={motion}
          sceneIndex={sceneIndex}
          castShadow={castShadow}
        />
      ) : (
        <LoadedStageImage
          entry={entry}
          url={url}
          placement={placement}
          motion={motion}
          sceneIndex={sceneIndex}
          castShadow={castShadow}
        />
      )}
    </AssetBoundary>
  );
}

function LoadedStageImage({
  entry,
  url,
  placement,
  motion,
  sceneIndex,
  castShadow,
}: {
  entry: SceneDocMediaSpec;
  url: string;
  placement: SceneImageStagePlacement;
  motion: SceneImageMotionSample;
  sceneIndex: number;
  castShadow: boolean;
}) {
  const texture = useColourTexture(url);
  const aspect = sourceAspect(texture);
  const transform = resolveStageImageTransform(placement, motion);
  const material = useMemo(() => {
    const next = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: IMAGE_ALPHA_TEST,
      depthWrite: true,
      side: DoubleSide,
    });
    next.shadowSide = DoubleSide;
    next.toneMapped = false;
    return next;
  }, [texture]);
  const shadowMaterials = useMemo(
    () => (castShadow ? createStageImageShadowMaterials(texture) : null),
    [castShadow, texture],
  );
  useLayoutEffect(
    () => () => {
      material.dispose();
      shadowMaterials?.depth.dispose();
      shadowMaterials?.distance.dispose();
    },
    [material, shadowMaterials],
  );
  material.opacity = transform.opacity;

  const baseRotation: [number, number, number] = [
    placement.rotationDeg[0] * DEG2RAD,
    placement.rotationDeg[1] * DEG2RAD,
    placement.rotationDeg[2] * DEG2RAD,
  ];

  return (
    <>
      <group position={transform.position} rotation={transform.rotation} scale={transform.size}>
        <mesh
          material={material}
          castShadow={castShadow}
          customDepthMaterial={shadowMaterials?.depth}
          customDistanceMaterial={shadowMaterials?.distance}
        >
          <planeGeometry args={[1, 1 / aspect]} />
        </mesh>
      </group>
      <group position={placement.position} rotation={baseRotation} scale={placement.size}>
        <StageImageOutline imageId={entry.id} sceneIndex={sceneIndex} localSize={[1, 1 / aspect]} />
      </group>
      <StageImageGizmo imageId={entry.id} sceneIndex={sceneIndex} committed={entry.stage} />
    </>
  );
}

/** The same Stage plane and placement as `LoadedStageImage`, wearing the window chrome: the card mask and border on the plane, the recording crop remapping its UVs (and setting the aspect the crop leaves), and the drop shadow riding the same group. It takes the window path's material, so a chromed card sorts with the other transparent content instead of writing depth, and its cast shadow stays the plane's rectangle (the depth material never sees the mask). */
function ChromedStageImage({
  entry,
  url,
  placement,
  motion,
  sceneIndex,
  castShadow,
}: {
  entry: SceneDocMediaSpec;
  url: string;
  placement: SceneImageStagePlacement;
  motion: SceneImageMotionSample;
  sceneIndex: number;
  castShadow: boolean;
}) {
  const texture = useColourTexture(url);
  const chrome = useMemo(
    () => normalizeWindowChrome(entry.window ?? BARE_WINDOW_CHROME),
    [entry.window],
  );
  const surface = windowChromeSurface(chrome, textureIntrinsics(texture));
  const aspect = surface.cropAspect ?? sourceAspect(texture);
  const rect: Rect = { width: 1, height: 1 / aspect };
  const transform = resolveStageImageTransform(placement, motion);
  const { material, card, uv } = useWindowMaterial(texture, DoubleSide);
  applyWindowUniforms(
    card,
    uv,
    { rect, radiusFraction: surface.radiusFraction, uv: surface.uv },
    chrome,
  );
  material.opacity = transform.opacity;
  const shadowMaterials = useMemo(
    () => (castShadow ? createStageImageShadowMaterials(texture) : null),
    [castShadow, texture],
  );
  useLayoutEffect(
    () => () => {
      shadowMaterials?.depth.dispose();
      shadowMaterials?.distance.dispose();
    },
    [shadowMaterials],
  );

  return (
    <>
      <group position={transform.position} rotation={transform.rotation} scale={transform.size}>
        <WindowShadow rect={rect} shadow={chrome.shadow} radiusFraction={surface.radiusFraction} />
        <mesh
          material={material}
          castShadow={castShadow}
          customDepthMaterial={shadowMaterials?.depth}
          customDistanceMaterial={shadowMaterials?.distance}
        >
          <planeGeometry args={[rect.width, rect.height]} />
        </mesh>
      </group>
      <group
        position={placement.position}
        rotation={[
          placement.rotationDeg[0] * DEG2RAD,
          placement.rotationDeg[1] * DEG2RAD,
          placement.rotationDeg[2] * DEG2RAD,
        ]}
        scale={placement.size}
      >
        <StageImageOutline
          imageId={entry.id}
          sceneIndex={sceneIndex}
          localSize={[rect.width, rect.height]}
        />
      </group>
      <StageImageGizmo imageId={entry.id} sceneIndex={sceneIndex} committed={entry.stage} />
    </>
  );
}

/** A Stage-hosted video: the image plane's placement and outline over a clip-driven material. No cast shadow, since the shadow materials would have to be rebuilt per bound frame. */
function StageVideo({
  entry,
  placement,
  motion,
  sceneIndex,
}: {
  entry: SceneDocMediaSpec;
  placement: SceneImageStagePlacement;
  motion: SceneImageMotionSample;
  sceneIndex: number;
}) {
  const [intrinsics, onIntrinsics] = useClipIntrinsics();
  const transform = resolveStageImageTransform(placement, motion);
  const material = useMemo(() => {
    const next = new MeshBasicMaterial({ transparent: true, depthWrite: true, side: DoubleSide });
    next.toneMapped = false;
    return next;
  }, []);
  useLayoutEffect(() => () => material.dispose(), [material]);
  material.opacity = transform.opacity;
  const aspect = intrinsics
    ? intrinsics.width / intrinsics.height
    : (entry.video?.aspect ?? DEFAULT_CLIP_ASPECT);
  const rect = { width: 1, height: 1 / aspect };
  return (
    <>
      <group position={transform.position} rotation={transform.rotation} scale={transform.size}>
        <ClipPlane
          src={entry.src}
          startMs={entry.video?.startMs ?? 0}
          loop={entry.video?.loop === true}
          material={material}
          rect={rect}
          onIntrinsics={onIntrinsics}
        />
      </group>
      <group
        position={placement.position}
        rotation={[
          placement.rotationDeg[0] * DEG2RAD,
          placement.rotationDeg[1] * DEG2RAD,
          placement.rotationDeg[2] * DEG2RAD,
        ]}
        scale={placement.size}
      >
        <StageImageOutline
          imageId={entry.id}
          sceneIndex={sceneIndex}
          localSize={[rect.width, rect.height]}
        />
      </group>
      <StageImageGizmo imageId={entry.id} sceneIndex={sceneIndex} committed={entry.stage} />
    </>
  );
}

// ── Overlay-hosted media (the frame layer) ────────────────────────────────────

function OverlayMedia({ entry, stackOrder }: { entry: SceneDocMediaSpec; stackOrder: number }) {
  const context = useSceneContext();
  const sceneIndex = context?.index ?? -1;
  const exporting = isExporting();
  const editable = context?.side === undefined && !exporting;
  const sectionOpen = useGizmoSectionOpen("media");
  const preview = useImageOverlayPreview(sceneIndex, entry.id, editable);
  const { localMs } = useTimeline();
  const format = useFormat();
  const url = useSceneImageUrl(entry.kind === "image" ? entry.src : null);
  const placement = preview ?? entry.overlay;
  const motion = sampleRenderedSceneMediaMotion(
    entry,
    localMs,
    shouldNeutraliseSceneMediaMotion(sectionOpen, exporting),
  );
  if (entry.kind === "video") {
    return (
      <OverlayVideo
        entry={entry}
        placement={placement}
        motion={motion}
        format={format}
        stackOrder={stackOrder}
      />
    );
  }
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={entry.src}>
      {entry.window ? (
        <ChromedOverlayImage
          entry={entry}
          url={url}
          placement={placement}
          motion={motion}
          format={format}
          stackOrder={stackOrder}
        />
      ) : (
        <LoadedOverlayImage
          url={url}
          placement={placement}
          motion={motion}
          format={format}
          stackOrder={stackOrder}
        />
      )}
    </AssetBoundary>
  );
}

function LoadedOverlayImage({
  url,
  placement,
  motion,
  format,
  stackOrder,
}: {
  url: string;
  placement: SceneImageOverlayPlacement;
  motion: SceneImageMotionSample;
  format: FormatInfo;
  stackOrder: number;
}) {
  const texture = useColourTexture(url);
  const transform = resolveOverlayImageTransform(
    placement,
    motion,
    format,
    sourceAspect(texture),
    stackOrder,
  );
  const circle = placement.shape === "circle";
  const material = useMemo(() => {
    const next = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    next.toneMapped = false;
    if (circle) applyCircleMask(next);
    return next;
  }, [circle, texture]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  material.opacity = transform.opacity;

  return (
    <mesh
      position={transform.position}
      rotation={transform.rotation}
      material={material}
      renderOrder={transform.renderOrder}
    >
      <planeGeometry args={[transform.width, transform.height]} />
    </mesh>
  );
}

/** The same frame-layer plane and sizing as `LoadedOverlayImage`, wearing the window chrome. The card mask supersedes the circle crop while a window block exists, and the shadow shares the plane's render order (it sits behind, so the depth tiebreak draws it first). */
function ChromedOverlayImage({
  entry,
  url,
  placement,
  motion,
  format,
  stackOrder,
}: {
  entry: SceneDocMediaSpec;
  url: string;
  placement: SceneImageOverlayPlacement;
  motion: SceneImageMotionSample;
  format: FormatInfo;
  stackOrder: number;
}) {
  const texture = useColourTexture(url);
  const chrome = useMemo(
    () => normalizeWindowChrome(entry.window ?? BARE_WINDOW_CHROME),
    [entry.window],
  );
  const surface = windowChromeSurface(chrome, textureIntrinsics(texture));
  const transform = resolveOverlayImageTransform(
    placement,
    motion,
    format,
    surface.cropAspect ?? sourceAspect(texture),
    stackOrder,
  );
  const rect: Rect = { width: transform.width, height: transform.height };
  const { material, card, uv } = useWindowMaterial(texture, DoubleSide);
  applyWindowUniforms(
    card,
    uv,
    { rect, radiusFraction: surface.radiusFraction, uv: surface.uv },
    chrome,
  );
  material.opacity = transform.opacity;
  return (
    <group position={transform.position} rotation={transform.rotation}>
      <WindowShadow
        rect={rect}
        shadow={chrome.shadow}
        radiusFraction={surface.radiusFraction}
        renderOrder={transform.renderOrder}
      />
      <mesh material={material} renderOrder={transform.renderOrder}>
        <planeGeometry args={[rect.width, rect.height]} />
      </mesh>
    </group>
  );
}

/** The frame layer's clip material: the window card mask when the entry authors chrome, otherwise the plain plane the stills use, circle crop included. One hook either way, so the branch never moves a hook. */
function useOverlayVideoMaterial(
  chromed: boolean,
  circle: boolean,
): { material: MeshBasicMaterial; card: CardUniforms; uv: WindowUvUniforms } {
  const card = useMemo(() => cardUniforms(), []);
  const uv = useMemo(() => windowUvUniforms(), []);
  const material = useMemo(() => {
    const next = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    next.toneMapped = false;
    if (chromed) applyWindowMask(next, card, uv);
    else if (circle) applyCircleMask(next);
    return next;
  }, [card, chromed, circle, uv]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  return { material, card, uv };
}

/** An Overlay-hosted clip: the still's frame-layer plane and sizing (`size` IS the width, the source aspect sets the height) over the deterministic clip pipeline, wearing the window chrome as plane decoration exactly as `ChromedOverlayImage` does. The window HOST is the floating world-space clip; this is the camera-locked one. */
function OverlayVideo({
  entry,
  placement,
  motion,
  format,
  stackOrder,
}: {
  entry: SceneDocMediaSpec;
  placement: SceneImageOverlayPlacement;
  motion: SceneImageMotionSample;
  format: FormatInfo;
  stackOrder: number;
}) {
  const [intrinsics, onIntrinsics] = useClipIntrinsics();
  const chromed = entry.window !== undefined;
  const chrome = useMemo(
    () => normalizeWindowChrome(entry.window ?? BARE_WINDOW_CHROME),
    [entry.window],
  );
  const surface = windowChromeSurface(chrome, intrinsics);
  const transform = resolveOverlayImageTransform(
    placement,
    motion,
    format,
    resolveClipAspect(surface.cropAspect, intrinsics, entry.video?.aspect ?? null),
    stackOrder,
  );
  const rect: Rect = { width: transform.width, height: transform.height };
  const { material, card, uv } = useOverlayVideoMaterial(chromed, placement.shape === "circle");
  if (chromed) {
    applyWindowUniforms(
      card,
      uv,
      { rect, radiusFraction: surface.radiusFraction, uv: surface.uv },
      chrome,
    );
  }
  material.opacity = transform.opacity;
  return (
    <group position={transform.position} rotation={transform.rotation}>
      {chromed && (
        <WindowShadow
          rect={rect}
          shadow={chrome.shadow}
          radiusFraction={surface.radiusFraction}
          renderOrder={transform.renderOrder}
        />
      )}
      <ClipPlane
        src={entry.src}
        startMs={entry.video?.startMs ?? 0}
        loop={entry.video?.loop === true}
        material={material}
        rect={rect}
        renderOrder={transform.renderOrder}
        onIntrinsics={onIntrinsics}
      />
    </group>
  );
}

// ── Mounts ────────────────────────────────────────────────────────────────────

function WorldMedia({
  entries,
  mapShadows,
}: {
  entries: readonly SceneDocMediaSpec[];
  mapShadows: boolean;
}) {
  return (
    <>
      {entries.map((entry) =>
        sceneMediaUsesWindowPath(entry) ? (
          <WindowMedia key={entry.id} entry={entry} />
        ) : (
          <StageMedia key={entry.id} entry={entry} mapShadows={mapShadows} />
        ),
      )}
    </>
  );
}

/** The Stage family, mounted by `<SceneStage>`: every Stage-hosted entry, chrome or not. Registers the scene as that family's consumer so the host-side fallback stands down. */
export function StageSceneMedia() {
  const entries = useSceneMedia("stage");
  const mapShadows = useStageMapShadows();
  if (entries.length === 0) return null;
  return <WorldMedia entries={entries} mapShadows={mapShadows} />;
}

/** The window family, mounted by a scene's own `<VideoWindow/>`: every window-hosted clip, the floating world-space window. */
export function SceneWindowMedia() {
  const entries = useSceneMedia("window");
  if (entries.length === 0) return null;
  return <WorldMedia entries={entries} mapShadows={false} />;
}

/** Host-side world media for scenes whose TSX wires neither `<SceneStage>` nor `<VideoWindow/>` (mounted by SceneHost, the DevicesFallback pattern): reads the doc directly so it can't register as a consumer itself, and stands each family down separately. */
export function SceneMediaFallback() {
  const doc = useContext(SceneDocContext) ?? undefined;
  const sceneIndex = useSceneContext()?.index;
  const entries = useMemo(() => sceneMediaInWorld(resolveSceneDocMedia(doc)), [doc]);
  if (entries.length === 0) return null;
  return <SceneMediaFallbackContent entries={entries} sceneIndex={sceneIndex} />;
}

function SceneMediaFallbackContent({
  entries,
  sceneIndex,
}: {
  entries: readonly SceneDocMediaSpec[];
  sceneIndex: number | undefined;
}) {
  const stageConsumed = useSceneConsumesMedia(sceneIndex, "stage");
  const windowConsumed = useSceneConsumesMedia(sceneIndex, "window");
  const left = entries.filter((entry) =>
    sceneMediaFamily(entry) === "window" ? !windowConsumed : !stageConsumed,
  );
  if (left.length === 0) return null;
  return <WorldMedia entries={left} mapShadows={false} />;
}

/** The frame layer's media: every Overlay-hosted entry, either kind, drawn over the composited slide. */
export function OverlaySceneMedia({ orderStart }: { orderStart: number }) {
  const doc = useContext(SceneDocContext) ?? undefined;
  const entries = useMemo(() => sceneMediaInFrame(resolveSceneDocMedia(doc)), [doc]);
  if (entries.length === 0) return null;
  const stackOrders = resolveOverlayImageStackOrders(entries, orderStart);
  return (
    <>
      {entries.map((entry, index) => (
        <OverlayMedia key={entry.id} entry={entry} stackOrder={stackOrders[index]} />
      ))}
    </>
  );
}
