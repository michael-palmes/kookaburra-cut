import { useTexture } from "@react-three/drei";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type Group,
  MeshBasicMaterial,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
} from "three";
import { clipPlaneSize } from "../../engine/clipFrame";
import { useClipTexture } from "../../engine/clipTexture";
import { useFormat } from "../../engine/format";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext, SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useSceneVideoWindow } from "../../engine/sceneDoc";
import type { VideoWindowBorder, VideoWindowStage } from "../../engine/sceneDocSchema";
import {
  type NormalizedVideoWindow,
  type NormalizedVideoWindowShadow,
  normalizeVideoWindow,
  sampleVideoWindowMotion,
} from "../../engine/sceneVideoWindow";
import { useTimeline } from "../../engine/timeline";
import { useSceneConsumesVideoWindow } from "../../engine/videoWindowRegistry";
import { useEditorStore } from "../../store/editorStore";
import { gradientTexture, useExactMaterial } from "../stage/backdrops";
import { AssetBoundary } from "./AssetBoundary";
import { applyCardMask, cardUniforms, SHADOW_FRAG, SHADOW_VERT } from "./LayeredScreenshot";

/** Depth (world units) of the backing stage behind the window group; the "set back a bit" gap that gives parallax under the scene camera. */
const STAGE_GAP = 0.6;
/** The stage plane is sized this multiple of the frame so it stays full-bleed while the camera rotates within a limited range (roughly ±15°). */
const STAGE_OVERSCAN = 2;
/** The shadow quad sits just behind the window inside the moving group, so it tracks the window's motion. */
const SHADOW_BEHIND = 0.12;
/** Placeholder aspect before the clip's intrinsics arrive (the mesh is hidden until the first frame binds; exports have intrinsics by frame 0 behind the extract barrier). */
const DEFAULT_CLIP_ASPECT = 16 / 9;

interface Rect {
  width: number;
  height: number;
}

function useResolvedProjectId(): string {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  return contextProjectId ?? storeProjectId;
}

// ── Backing stage (full-bleed wallpaper) ──────────────────────────────────────

function ColorStage({ color, w, h }: { color: string; w: number; h: number }) {
  const material = useExactMaterial((m) => m.color.set(color), [color]);
  return (
    <mesh material={material} position={[0, 0, -STAGE_GAP]}>
      <planeGeometry args={[w, h]} />
    </mesh>
  );
}

function GradientStage({
  spec,
  w,
  h,
}: {
  spec: Extract<VideoWindowStage, { type: "gradient" }>["spec"];
  w: number;
  h: number;
}) {
  const texture = useMemo(() => gradientTexture(spec), [spec]);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  const material = useExactMaterial(
    (m) => {
      m.map = texture;
    },
    [texture],
  );
  return (
    <mesh material={material} position={[0, 0, -STAGE_GAP]}>
      <planeGeometry args={[w, h]} />
    </mesh>
  );
}

function ImageStageLoaded({
  url,
  fit,
  w,
  h,
}: {
  url: string;
  fit: "cover" | "contain";
  w: number;
  h: number;
}) {
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    // Cover-fit: crop via repeat/offset so the wallpaper fills the plane without stretching.
    const img = texture.image as { width: number; height: number } | undefined;
    if (img && fit !== "contain") {
      const planeAspect = w / h;
      const imageAspect = img.width / img.height;
      if (imageAspect > planeAspect) {
        texture.repeat.set(planeAspect / imageAspect, 1);
        texture.offset.set((1 - texture.repeat.x) / 2, 0);
      } else {
        texture.repeat.set(1, imageAspect / planeAspect);
        texture.offset.set(0, (1 - texture.repeat.y) / 2);
      }
    }
    texture.needsUpdate = true;
  }, [texture, fit, w, h]);
  const material = useExactMaterial(
    (m) => {
      m.map = texture;
    },
    [texture],
  );
  return (
    <mesh material={material} position={[0, 0, -STAGE_GAP]}>
      <planeGeometry args={[w, h]} />
    </mesh>
  );
}

function BackingStage({ stage, w, h }: { stage: VideoWindowStage; w: number; h: number }) {
  const projectId = useResolvedProjectId();
  if (stage.type === "color") return <ColorStage color={stage.color} w={w} h={h} />;
  if (stage.type === "gradient") return <GradientStage spec={stage.spec} w={w} h={h} />;
  // Missing assets degrade to no stage, never tear down the canvas tree (the backdrop lesson); the suspense load is covered by the scene-host commit barrier.
  let url: string | null = null;
  try {
    url = resolveAssetUrl(projectId, stage.src);
  } catch (e) {
    console.warn(`[videoWindow] stage image "${stage.src}" unresolved:`, e);
  }
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={stage.src}>
      <ImageStageLoaded url={url} fit={stage.fit ?? "cover"} w={w} h={h} />
    </AssetBoundary>
  );
}

// ── The window's drop shadow (analytic, reuses the LayeredScreenshot shaders) ──

function WindowShadow({
  rect,
  shadow,
  radiusFraction,
}: {
  rect: Rect;
  shadow: NormalizedVideoWindowShadow;
  radiusFraction: number;
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
    >
      <planeGeometry args={[width, height]} />
    </mesh>
  );
}

// ── The video window plane (rounded-rect masked, ready-gated video) ────────────

function WindowVideo({
  src,
  startMs,
  loop,
  rect,
  radiusFraction,
  border,
  onAspect,
}: {
  src: string;
  startMs: number;
  loop: boolean;
  rect: Rect;
  radiusFraction: number;
  border: VideoWindowBorder;
  onAspect: (aspect: number) => void;
}) {
  // The readiness node lives in this component's own subtree (the useClipTexture contract); content hides until the first frame binds so no untextured plane paints.
  const readyRef = useRef<Group>(null);
  const contentRef = useRef<Group>(null);
  const uniforms = useMemo(() => cardUniforms(), []);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    applyCardMask(m, uniforms);
    return m;
  }, [uniforms]);
  useLayoutEffect(() => () => material.dispose(), [material]);
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
    if (info && info.height > 0) onAspect(info.width / info.height);
  }, [info, onAspect]);

  const short = Math.min(rect.width, rect.height);
  uniforms.uCardSize.value.set(rect.width, rect.height);
  uniforms.uCardRadius.value = radiusFraction * short;
  uniforms.uCardStrokeColor.value.set(border.color);
  uniforms.uCardStrokeWidth.value = border.width * short;
  uniforms.uCardStrokeAlpha.value = border.enabled ? border.opacity : 0;

  return (
    <group ref={readyRef}>
      <group ref={contentRef} visible={false}>
        <mesh material={material}>
          <planeGeometry args={[rect.width, rect.height]} />
        </mesh>
      </group>
    </group>
  );
}

// ── Composition ───────────────────────────────────────────────────────────────

function VideoWindowRenderer({ w }: { w: NormalizedVideoWindow }) {
  const { localMs } = useTimeline();
  const format = useFormat();
  const [clipAspect, setClipAspect] = useState<number | null>(null);
  const onAspect = useCallback((a: number) => setClipAspect((prev) => (prev === a ? prev : a)), []);
  const aspect = clipAspect ?? DEFAULT_CLIP_ASPECT;
  const rect = clipPlaneSize(
    "contain",
    { width: format.frame.width * w.scale, height: format.frame.height * w.scale },
    { width: aspect, height: 1 },
  );
  const motion = sampleVideoWindowMotion(w.motion, localMs);
  const stageW = format.frame.width * STAGE_OVERSCAN;
  const stageH = format.frame.height * STAGE_OVERSCAN;
  return (
    <group>
      <BackingStage stage={w.stage} w={stageW} h={stageH} />
      <group
        position={[motion.posX, motion.posY, motion.posZ]}
        rotation={[motion.rotX, motion.rotY, 0]}
        scale={motion.scale}
      >
        <WindowShadow rect={rect} shadow={w.shadow} radiusFraction={w.radiusFraction} />
        <WindowVideo
          src={w.media.src}
          startMs={w.media.startMs}
          loop={w.media.loop}
          rect={rect}
          radiusFraction={w.radiusFraction}
          border={w.border}
          onAspect={onAspect}
        />
      </group>
    </group>
  );
}

export interface VideoWindowProps {
  /** Reserved: the primitive is sidecar-driven; props may later override the doc. */
  _reserved?: never;
}

/** The scene document's video window: a macOS screen recording as a floating rounded window with a drop shadow, over a full-bleed backing stage; sits in world space so the per-scene camera orbits it with real parallax. Registers the scene as a consumer so the host-side fallback stands down. */
export function VideoWindow(_props: VideoWindowProps = {}) {
  const normalized = useSceneVideoWindow();
  if (!normalized) return null;
  return <VideoWindowRenderer w={normalized} />;
}

/** Host-side window for scenes whose TSX never wires `useSceneVideoWindow` (mounted by SceneHost, the DevicesFallback pattern): reads the doc directly so it can't register as a consumer itself. */
export function VideoWindowFallback() {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  const consumed = useSceneConsumesVideoWindow(sceneIndex);
  const block = doc?.videoWindow;
  const normalized = useMemo(
    () => normalizeVideoWindow(block, `scene ${sceneIndex ?? "?"}`),
    [block, sceneIndex],
  );
  if (consumed || !normalized) return null;
  return <VideoWindowRenderer w={normalized} />;
}
