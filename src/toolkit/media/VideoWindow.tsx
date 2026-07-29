import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Group, MeshBasicMaterial, ShaderMaterial, Vector2 } from "three";
import { clipPlaneSize } from "../../engine/clipFrame";
import { useClipTexture } from "../../engine/clipTexture";
import { isExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useSceneVideoWindow } from "../../engine/sceneDoc";
import type { VideoWindowBorder } from "../../engine/sceneDocSchema";
import {
  type NormalizedVideoWindow,
  type NormalizedVideoWindowShadow,
  normalizeVideoWindow,
  recordingCrop,
  sampleVideoWindowMotion,
} from "../../engine/sceneVideoWindow";
import { useTimeline } from "../../engine/timeline";
import { useSceneConsumesVideoWindow } from "../../engine/videoWindowRegistry";
import {
  applyCardMask,
  type CardUniforms,
  cardUniforms,
  SHADOW_FRAG,
  SHADOW_VERT,
} from "./LayeredScreenshot";
import { preparingVideoTexture } from "./preparingTexture";

/** The shadow quad sits just behind the window inside the moving group, so it tracks the window's motion. */
const SHADOW_BEHIND = 0.12;
/** Last-resort aspect before the clip's intrinsics arrive; the doc's recorded `media.aspect` seeds first, so the window keeps its size across remounts and media swaps (exports have intrinsics by frame 0 behind the extract barrier). */
const DEFAULT_CLIP_ASPECT = 16 / 9;

interface Rect {
  width: number;
  height: number;
}

/** The recording-mode source crop as a UV transform (v = 0 is the frame's bottom, the clip pipeline's pre-flipped upload). */
interface WindowUv {
  scale: [number, number];
  offset: [number, number];
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

/** The card mask plus the recording crop's UV remap, under a VideoWindow-only program key. */
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

function WindowVideo({
  src,
  startMs,
  loop,
  rect,
  radiusFraction,
  border,
  uv,
  onIntrinsics,
}: {
  src: string;
  startMs: number;
  loop: boolean;
  rect: Rect;
  radiusFraction: number;
  border: VideoWindowBorder;
  uv: WindowUv | null;
  onIntrinsics: (width: number, height: number) => void;
}) {
  // The readiness node lives in this component's own subtree (the useClipTexture contract); content hides until the first frame binds so no untextured plane paints.
  const readyRef = useRef<Group>(null);
  const contentRef = useRef<Group>(null);
  const uniforms = useMemo(() => cardUniforms(), []);
  const uvUniforms = useMemo(() => windowUvUniforms(), []);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    applyWindowMask(m, uniforms, uvUniforms);
    return m;
  }, [uniforms, uvUniforms]);
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
    if (info && info.height > 0) onIntrinsics(info.width, info.height);
  }, [info, onIntrinsics]);

  const short = Math.min(rect.width, rect.height);
  uniforms.uCardSize.value.set(rect.width, rect.height);
  uniforms.uCardRadius.value = radiusFraction * short;
  uniforms.uCardStrokeColor.value.set(border.color);
  uniforms.uCardStrokeWidth.value = border.width * short;
  uniforms.uCardStrokeAlpha.value = border.enabled ? border.opacity : 0;
  uvUniforms.uVwUvScale.value.set(uv?.scale[0] ?? 1, uv?.scale[1] ?? 1);
  uvUniforms.uVwUvOffset.value.set(uv?.offset[0] ?? 0, uv?.offset[1] ?? 0);

  return (
    <group ref={readyRef}>
      <group ref={contentRef} visible={false}>
        <mesh material={material}>
          <planeGeometry args={[rect.width, rect.height]} />
        </mesh>
      </group>
      {/* While frames extract, the shared "Preparing video…" card fills the window, PREVIEW ONLY: `isExporting()` stands it down and the export barriers mean no captured frame can sample it anyway. */}
      {!info && !isExporting() && (
        <mesh>
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

// ── Composition ───────────────────────────────────────────────────────────────

function VideoWindowRenderer({ w }: { w: NormalizedVideoWindow }) {
  const { localMs } = useTimeline();
  const format = useFormat();
  const [intrinsics, setIntrinsics] = useState<{ width: number; height: number } | null>(null);
  const onIntrinsics = useCallback(
    (width: number, height: number) =>
      setIntrinsics((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      ),
    [],
  );
  const crop =
    w.recording && intrinsics ? recordingCrop(intrinsics.width, intrinsics.height) : null;
  const aspect = crop
    ? crop.width / crop.height
    : intrinsics
      ? intrinsics.width / intrinsics.height
      : (w.media.aspect ?? DEFAULT_CLIP_ASPECT);
  const radiusFraction = crop && w.radiusTracksRecording ? crop.radiusFraction : w.radiusFraction;
  const uv: WindowUv | null =
    crop && intrinsics
      ? {
          scale: [crop.width / intrinsics.width, crop.height / intrinsics.height],
          offset: [
            crop.x / intrinsics.width,
            (intrinsics.height - crop.y - crop.height) / intrinsics.height,
          ],
        }
      : null;
  const rect = clipPlaneSize(
    "contain",
    { width: format.frame.width * w.scale, height: format.frame.height * w.scale },
    { width: aspect, height: 1 },
  );
  const motion = sampleVideoWindowMotion(w.motion, localMs);
  return (
    <group
      position={[
        motion.posX + w.offset[0] * format.frame.width,
        motion.posY + w.offset[1] * format.frame.height,
        motion.posZ,
      ]}
      rotation={[motion.rotX, motion.rotY, 0]}
      scale={motion.scale}
    >
      <WindowShadow rect={rect} shadow={w.shadow} radiusFraction={radiusFraction} />
      <WindowVideo
        src={w.media.src}
        startMs={w.media.startMs}
        loop={w.media.loop}
        rect={rect}
        radiusFraction={radiusFraction}
        border={w.border}
        uv={uv}
        onIntrinsics={onIntrinsics}
      />
    </group>
  );
}

export interface VideoWindowProps {
  /** Reserved: the primitive is sidecar-driven; props may later override the doc. */
  _reserved?: never;
}

/** The scene document's video window: a macOS screen recording as a floating rounded window with a drop shadow, floating over whatever the scene stages behind it; sits in world space so the per-scene camera orbits it with real parallax. Registers the scene as a consumer so the host-side fallback stands down. */
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
