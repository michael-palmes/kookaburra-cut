import { useTexture } from "@react-three/drei";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Color,
  type Group,
  MeshBasicMaterial,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
} from "three";
import { useClipTexture } from "../../engine/clipTexture";
import { useFormat } from "../../engine/format";
import {
  fitStackScale,
  type MeasuredAspect,
  type SolvedItemRect,
  solveLayerLayout,
  spreadZToLocal,
} from "../../engine/layeredScreenshotLayout";
import { useLayeredScreenshotDraft } from "../../engine/layeredScreenshotEditStore";
import { useSceneConsumesLayeredScreenshot } from "../../engine/layeredScreenshotRegistry";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext, SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useSceneDoc, useSceneLayeredScreenshot, useSceneText } from "../../engine/sceneDoc";
import type {
  LayeredScreenshotScreenItem,
  LayeredScreenshotTextItem,
  SceneDoc,
} from "../../engine/sceneDocSchema";
import { presentSlideshowActive } from "../../engine/presentMode";
import {
  type NormalizedLayeredScreenshot,
  normalizeLayeredScreenshot,
  resolveLayeredScreenshotPose,
  sampleLoopedLayeredScreenshotTrack,
} from "../../engine/sceneLayeredScreenshot";
import { useTimeline } from "../../engine/timeline";
import { useEditorStore } from "../../store/editorStore";
import { type Theme, useTheme } from "../../theme";
import { AnimatedHeadline } from "../text/AnimatedHeadline";

const DEG2RAD = Math.PI / 180;
/** Corner radius when the theme has no `card` token, as a fraction of the card's short edge. */
const CARD_RADIUS_FRACTION = 0.05;
/** Hairline stroke: width as a fraction of the short edge, tinted with the theme text colour. */
const CARD_STROKE_FRACTION = 0.004;
const CARD_STROKE_ALPHA = 0.18;
/** Soft shadow: sized/offset relative to the card's short edge, opacity of the black quad. */
const SHADOW_BLUR_FRACTION = 0.14;
const SHADOW_DROP_FRACTION = 0.05;
const SHADOW_OPACITY = 0.3;
/** Shadow Z sits behind its card but MUST stay inside layeredScreenshotLayout's MIN_LAYER_STEP. */
const SHADOW_Z = 0.03;
/** Text items: font size as a share of the solved text-box height. */
const TEXT_FONT_RATIO = 0.34;

const cardRadius = (rect: SolvedItemRect, theme: Theme): number =>
  (theme.card?.radius ?? CARD_RADIUS_FRACTION) * Math.min(rect.width, rect.height);

/** The rounded-card uniform set: stable objects the compiled program holds (the image-shine pattern). */
interface CardUniforms {
  uCardSize: { value: Vector2 };
  uCardRadius: { value: number };
  uCardStrokeColor: { value: Color };
  uCardStrokeWidth: { value: number };
  uCardStrokeAlpha: { value: number };
}

const cardUniforms = (): CardUniforms => ({
  uCardSize: { value: new Vector2(1, 1) },
  uCardRadius: { value: 0 },
  uCardStrokeColor: { value: new Color(1, 1, 1) },
  uCardStrokeWidth: { value: 0 },
  uCardStrokeAlpha: { value: 0 },
});

const CARD_DEFS = /* glsl */ `
uniform vec2 uCardSize;
uniform float uCardRadius;
uniform vec3 uCardStrokeColor;
uniform float uCardStrokeWidth;
uniform float uCardStrokeAlpha;
`;

// Rounded-rect SDF alpha mask + a hairline stroke band just inside the edge, injected after <opaque_fragment> where gl_FragColor is fully composed (the ImageCard shine precedent).
const CARD_FRAGMENT = /* glsl */ `#include <opaque_fragment>
#ifdef USE_MAP
{
  vec2 lsP = (vMapUv - 0.5) * uCardSize;
  vec2 lsQ = abs(lsP) - 0.5 * uCardSize + uCardRadius;
  float lsD = length(max(lsQ, 0.0)) + min(max(lsQ.x, lsQ.y), 0.0) - uCardRadius;
  float lsAa = fwidth(lsD);
  float lsCoverage = 1.0 - smoothstep(-lsAa, lsAa, lsD);
  float lsStroke = 1.0 - smoothstep(-lsAa, lsAa, abs(lsD + uCardStrokeWidth) - uCardStrokeWidth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uCardStrokeColor, lsStroke * uCardStrokeAlpha);
  gl_FragColor.a *= lsCoverage;
}
#endif`;

function applyCardMask(material: MeshBasicMaterial, uniforms: CardUniforms): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = CARD_DEFS + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      CARD_FRAGMENT,
    );
  };
  material.customProgramCacheKey = () => "kookaburra-ls-card-v1";
}

/** Per-render uniform refresh, the ImageCard style: values are pure functions of the rect + theme. */
function refreshCardUniforms(uniforms: CardUniforms, rect: SolvedItemRect, theme: Theme): void {
  const short = Math.min(rect.width, rect.height);
  uniforms.uCardSize.value.set(rect.width, rect.height);
  uniforms.uCardRadius.value = cardRadius(rect, theme);
  uniforms.uCardStrokeColor.value.set(theme.colors.text);
  uniforms.uCardStrokeWidth.value = CARD_STROKE_FRACTION * short;
  uniforms.uCardStrokeAlpha.value = CARD_STROKE_ALPHA;
}

// language=GLSL
const SHADOW_VERT = /* glsl */ `
uniform vec2 uSize;
varying vec2 vPos;
void main() {
  vPos = (uv - 0.5) * uSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// language=GLSL
const SHADOW_FRAG = /* glsl */ `
uniform vec2 uHalf;
uniform float uRadius;
uniform float uBlur;
uniform float uOpacity;
varying vec2 vPos;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  float d = sdRoundBox(vPos, uHalf, uRadius);
  float coverage = 1.0 - smoothstep(-uBlur, uBlur, d);
  gl_FragColor = vec4(0.0, 0.0, 0.0, coverage * uOpacity);
}
`;

/** The card's analytic soft shadow (the Device SunShadow technique, undirected): a slightly dropped black round-rect blur on a quad just behind the card. */
function CardShadow({ rect, theme }: { rect: SolvedItemRect; theme: Theme }) {
  const short = Math.min(rect.width, rect.height);
  const blur = SHADOW_BLUR_FRACTION * short;
  const width = rect.width + blur * 2;
  const height = rect.height + blur * 2;
  const radius = cardRadius(rect, theme);
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
          uOpacity: { value: SHADOW_OPACITY },
        },
      }),
    [width, height, rect.width, rect.height, radius, blur],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);
  return (
    <mesh position={[rect.x, rect.y - SHADOW_DROP_FRACTION * short, -SHADOW_Z]} material={material}>
      <planeGeometry args={[width, height]} />
    </mesh>
  );
}

function ScreenImageCard({
  rect,
  texture,
  flat,
  theme,
}: {
  rect: SolvedItemRect;
  texture: Texture;
  flat: boolean;
  theme: Theme;
}) {
  const uniforms = useMemo(() => (flat ? null : cardUniforms()), [flat]);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    m.map = texture;
    if (uniforms) applyCardMask(m, uniforms);
    return m;
  }, [texture, uniforms]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  if (uniforms) refreshCardUniforms(uniforms, rect, theme);
  return (
    <>
      {!flat && <CardShadow rect={rect} theme={theme} />}
      <mesh position={[rect.x, rect.y, 0]} material={material}>
        <planeGeometry args={[rect.width, rect.height]} />
      </mesh>
    </>
  );
}

function ScreenVideoCard({
  item,
  rect,
  flat,
  theme,
  onAspect,
}: {
  item: LayeredScreenshotScreenItem;
  rect: SolvedItemRect;
  flat: boolean;
  theme: Theme;
  onAspect: (id: string, aspect: number) => void;
}) {
  // The readiness node lives in this component's own subtree (the ScreenVideo contract); content hides until the first frame binds so no untextured plane ever paints.
  const readyRef = useRef<Group>(null);
  const contentRef = useRef<Group>(null);
  const uniforms = useMemo(() => (flat ? null : cardUniforms()), [flat]);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    if (uniforms) applyCardMask(m, uniforms);
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
    src: item.src,
    startMs: item.startMs ?? 0,
    material,
    readyObjectRef: readyRef,
    onPending,
    onBound,
  });
  useLayoutEffect(() => {
    if (info && info.height > 0) onAspect(item.id, info.width / info.height);
  }, [info, item.id, onAspect]);
  if (uniforms) refreshCardUniforms(uniforms, rect, theme);
  return (
    <group ref={readyRef}>
      <group ref={contentRef} visible={false}>
        {!flat && <CardShadow rect={rect} theme={theme} />}
        <mesh position={[rect.x, rect.y, 0]} material={material}>
          <planeGeometry args={[rect.width, rect.height]} />
        </mesh>
      </group>
    </group>
  );
}

function TextCard({ item, rect }: { item: LayeredScreenshotTextItem; rect: SolvedItemRect }) {
  const textKey = `ls-${item.id}`;
  const text = useSceneText(textKey, "Label");
  return (
    <AnimatedHeadline
      text={text}
      textKey={textKey}
      from={0}
      to={0}
      position={[rect.x, rect.y, 0]}
      fontSize={rect.height * TEXT_FONT_RATIO}
      maxWidth={rect.width}
    />
  );
}

function useResolvedProjectId(): string {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  return contextProjectId ?? storeProjectId;
}

/** The stack at its resolved pose: visible layers sorted by `z`, each solved on its own plane, auto-fitted to the safe frame at spread 0, then posed as one group (pan / orbit counter-rotation / fitted zoom). Scene-local by construction: the pose is this group's own transform, never the world camera. */
function StackRenderer({
  normalized,
  animatedTrack,
}: {
  normalized: NormalizedLayeredScreenshot;
  animatedTrack: SceneDoc["animatedTrack"];
}) {
  const { localMs } = useTimeline();
  const format = useFormat();
  const theme = useTheme();
  const projectId = useResolvedProjectId();

  const layers = useMemo(
    () =>
      normalized.layers.filter((l) => l.visible && l.items.length > 0).sort((a, b) => a.z - b.z),
    [normalized],
  );

  // A missing image degrades to nothing; never tear down the canvas tree (the ImageCard contract).
  const images = useMemo(() => {
    const out: { id: string; url: string }[] = [];
    for (const layer of layers) {
      for (const item of layer.items) {
        if (item.kind !== "screen" || item.media !== "image") continue;
        try {
          const url = resolveAssetUrl(projectId, item.src);
          if (url) out.push({ id: item.id, url });
        } catch (e) {
          console.warn(`[layeredScreenshot] "${item.src}" unresolved:`, e);
        }
      }
    }
    return out;
  }, [layers, projectId]);

  const textures = useTexture(images.map((i) => i.url)) as Texture[];
  useLayoutEffect(() => {
    for (const texture of textures) {
      texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
    }
  }, [textures]);

  // Video intrinsics land async from the clip pipeline; until then the solver's kind fallback places the card (exports always have them by frame 0, behind the extract barrier).
  const [clipAspects, setClipAspects] = useState<Record<string, number>>({});
  const onClipAspect = useCallback((id: string, aspect: number) => {
    setClipAspects((prev) => (prev[id] === aspect ? prev : { ...prev, [id]: aspect }));
  }, []);

  const aspects = useMemo(() => {
    const out: MeasuredAspect[] = [];
    images.forEach(({ id }, i) => {
      const img = textures[i]?.image as { width: number; height: number } | undefined;
      if (img && img.height > 0) out.push({ id, aspect: img.width / img.height });
    });
    for (const [id, aspect] of Object.entries(clipAspects)) out.push({ id, aspect });
    return out;
  }, [images, textures, clipAspects]);

  const layouts = useMemo(() => layers.map((l) => solveLayerLayout(l, aspects)), [layers, aspects]);
  const fit = fitStackScale(
    layouts,
    format.frame.width - format.safe.left - format.safe.right,
    format.frame.height - format.safe.top - format.safe.bottom,
  );

  // Slideshow holds loop the animation when it asks for it; the flag is realm-local, so preview and export stay on the play-once sample by construction.
  const loop = animatedTrack === "layeredScreenshot" ? normalized.track?.presentLoop : undefined;
  const pose =
    loop && normalized.track && presentSlideshowActive()
      ? sampleLoopedLayeredScreenshotTrack(normalized.track, localMs, loop)
      : resolveLayeredScreenshotPose(normalized, animatedTrack, localMs);
  const zOffsets = spreadZToLocal(pose.spread, layers.length);

  if (layers.length === 0) return null;
  return (
    <group
      position={[pose.pan[0], pose.pan[1], 0]}
      // The pose reads as the viewer's orbit (the scene-camera convention); the stack counter-rotates.
      rotation={[pose.elevationDeg * DEG2RAD, -pose.azimuthDeg * DEG2RAD, 0]}
      scale={fit * pose.zoom}
    >
      {layers.map((layer, li) => (
        <group key={layer.id} position={[0, 0, zOffsets[li]]}>
          {layer.items.map((item) => {
            const rect = layouts[li].items.find((r) => r.id === item.id);
            if (!rect) return null;
            if (item.kind === "text") return <TextCard key={item.id} item={item} rect={rect} />;
            const flat = item.flat ?? layer.flat ?? false;
            if (item.media === "video") {
              return (
                <ScreenVideoCard
                  key={item.id}
                  item={item}
                  rect={rect}
                  flat={flat}
                  theme={theme}
                  onAspect={onClipAspect}
                />
              );
            }
            const ti = images.findIndex((i) => i.id === item.id);
            const texture = ti >= 0 ? textures[ti] : undefined;
            if (!texture) return null;
            return (
              <ScreenImageCard
                key={item.id}
                rect={rect}
                texture={texture}
                flat={flat}
                theme={theme}
              />
            );
          })}
        </group>
      ))}
    </group>
  );
}

export interface LayeredScreenshotProps {
  /** Reserved: the primitive is sidecar-driven; props may later override the doc. */
  _reserved?: never;
}

/** The scene document's layered-screenshot stack at its resolved pose (rest pose, or the sampled animation when the scene's animated track is the layered screenshot). Registers the scene as a consumer so the host-side fallback stands down. In-flight builder drafts merge here in React behind the store's export guard, so the export path only ever sees the sidecar. */
export function LayeredScreenshot(_props: LayeredScreenshotProps = {}) {
  const fromDoc = useSceneLayeredScreenshot();
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  const draft = useLayeredScreenshotDraft(useResolvedProjectId(), sceneIndex);
  const normalized = draft ? draft.normalized : fromDoc;
  if (!normalized) return null;
  return <StackRenderer normalized={normalized} animatedTrack={doc?.animatedTrack} />;
}

/** Host-side stack for scenes whose TSX never wires `useSceneLayeredScreenshot` (mounted by SceneHost, the DevicesFallback pattern): reads the doc directly so it can't register as a consumer itself; drafts merge exactly as in the primitive. */
export function LayeredScreenshotFallback() {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  const consumed = useSceneConsumesLayeredScreenshot(sceneIndex);
  const draft = useLayeredScreenshotDraft(useResolvedProjectId(), sceneIndex);
  const block = doc?.layeredScreenshot;
  const fromDoc = useMemo(
    () => normalizeLayeredScreenshot(block, `scene ${sceneIndex ?? "?"}`),
    [block, sceneIndex],
  );
  const normalized = draft ? draft.normalized : fromDoc;
  if (consumed || !normalized) return null;
  return <StackRenderer normalized={normalized} animatedTrack={doc?.animatedTrack} />;
}
