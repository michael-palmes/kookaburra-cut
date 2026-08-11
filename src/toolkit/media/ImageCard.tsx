import { useTexture } from "@react-three/drei";
import { useContext, useLayoutEffect, useMemo } from "react";
import { MeshBasicMaterial, SRGBColorSpace, type Texture, Vector2, Vector4 } from "three";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext } from "../../engine/sceneContext";
import { useTimeline } from "../../engine/timeline";
import { assetVersionKey, useAssetVersionStore } from "../../store/assetVersionStore";
import { useEditorStore } from "../../store/editorStore";
import { foldBandToChild, GroupAnimationContext, groupImageEffects } from "../group/context";
import { SHINE_AXIS, SHINE_INTENSITY } from "../text/presets";
import type { V3 } from "../types";
import { AssetBoundary } from "./AssetBoundary";

export interface ImageCardProps {
  /** Project-relative asset path (e.g. `assets/app-icon.png`). */
  src: string;
  position?: V3;
  /** World-unit width; height follows the image's aspect ratio. */
  width?: number;
  /** Optional linear fade-in window, ms (local scene time). Absent = always opaque. */
  from?: number;
  to?: number;
}

/** A flat image plane for icons, logos and stills: renders UNLIT with `toneMapped: false` so the asset's pixels land exactly (the device-screen/backdrop precedent), respecting PNG alpha so rounded/irregular shapes come from the asset itself; the suspense texture load is settled by the export preamble before frame 0. */
export function ImageCard(props: ImageCardProps) {
  const { src, position = [0, 0, 0], width = 1, from, to } = props;
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  // Re-render when the asset is re-imported in place (app-icon swap) so the URL busts.
  const version = useAssetVersionStore((s) => s.versions[assetVersionKey(projectId, src)] ?? 0);
  // A missing asset degrades to nothing; never tear down the canvas tree.
  let url: string | null = null;
  try {
    url = resolveAssetUrl(projectId, src);
    if (version > 0) url += `?v=${version}`;
  } catch (e) {
    console.warn(`[image] "${src}" unresolved:`, e);
  }
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={src}>
      <LoadedImageCard url={url} position={position} width={width} from={from} to={to} />
    </AssetBoundary>
  );
}

/** The group-shine uniform set: stable objects the compiled program holds. */
interface ImageShineUniforms {
  uGanShine: { value: Vector4 };
  uGanShineAxis: { value: Vector2 };
  uGanSize: { value: Vector2 };
}

interface ImageMotionUniforms {
  uGanImageBlur: { value: Vector4 };
  uGanImageMask: { value: Vector4 };
}

// The same soft smoothstep band as the text shine, masked to the sampled texture's alpha (2026-07-09 decision) so rounded/irregular icons shine only where they have pixels; both lifts match the text (rgb brightens dark pixels, alpha lift keeps the band visible on a mid-fade card), injected after <opaque_fragment> where gl_FragColor is fully composed.
const IMAGE_SHINE_FRAGMENT = /* glsl */ `#include <opaque_fragment>
#ifdef USE_MAP
if (uGanShine.w > 0.5) {
  vec2 ganPos = (vMapUv - 0.5) * uGanSize;
  float ganShineD = abs(dot(ganPos, uGanShineAxis) - uGanShine.x) * uGanShine.y;
  float ganShineT = clamp(1.0 - ganShineD, 0.0, 1.0);
  float ganShine = (ganShineT * ganShineT * (3.0 - 2.0 * ganShineT)) * uGanShine.z
    * texture2D(map, vMapUv).a;
  gl_FragColor.rgb += ganShine;
  gl_FragColor.a = clamp(gl_FragColor.a + ganShine, 0.0, 1.0);
}
#endif`;

const IMAGE_SHINE_DEFS = /* glsl */ `
uniform vec4 uGanShine;
uniform vec2 uGanShineAxis;
uniform vec2 uGanSize;
`;

const IMAGE_MOTION_DEFS = /* glsl */ `
uniform vec4 uGanImageBlur;
uniform vec4 uGanImageMask;
`;

const IMAGE_MOTION_MAP = /* glsl */ `
#ifdef USE_MAP
vec4 sampledDiffuseColor = texture2D(map, vMapUv);
if (uGanImageBlur.z > 0.5 && max(uGanImageBlur.x, uGanImageBlur.y) > 0.0) {
  vec2 d = uGanImageBlur.xy;
  sampledDiffuseColor = sampledDiffuseColor * 0.2
    + texture2D(map, vMapUv + vec2(d.x, 0.0)) * 0.12
    + texture2D(map, vMapUv - vec2(d.x, 0.0)) * 0.12
    + texture2D(map, vMapUv + vec2(0.0, d.y)) * 0.12
    + texture2D(map, vMapUv - vec2(0.0, d.y)) * 0.12
    + texture2D(map, vMapUv + d) * 0.08
    + texture2D(map, vMapUv - d) * 0.08
    + texture2D(map, vMapUv + vec2(d.x, -d.y)) * 0.08
    + texture2D(map, vMapUv + vec2(-d.x, d.y)) * 0.08;
}
diffuseColor *= sampledDiffuseColor;
#endif
`;

const IMAGE_MOTION_MASK = /* glsl */ `if (uGanImageMask.w > 0.5) {
  float feather = max(uGanImageMask.z, 0.00001);
  float left = smoothstep(uGanImageMask.x - feather, uGanImageMask.x + feather, vMapUv.x);
  float right = 1.0 - smoothstep(uGanImageMask.y - feather, uGanImageMask.y + feather, vMapUv.x);
  gl_FragColor.a *= left * right;
}`;

/** Patch the group-shine band into a card's material (the Device GSAA precedent); only ever applied inside shine-capable groups, so cards outside groups keep the stock program, zero regression surface. */
function applyImageEffects(
  material: MeshBasicMaterial,
  shine: ImageShineUniforms | null,
  motion: ImageMotionUniforms | null,
): void {
  material.onBeforeCompile = (shader) => {
    let opaque = "#include <opaque_fragment>";
    if (shine) {
      shader.uniforms.uGanShine = shine.uGanShine;
      shader.uniforms.uGanShineAxis = shine.uGanShineAxis;
      shader.uniforms.uGanSize = shine.uGanSize;
      shader.fragmentShader = IMAGE_SHINE_DEFS + shader.fragmentShader;
      opaque = IMAGE_SHINE_FRAGMENT;
    }
    if (motion) {
      shader.uniforms.uGanImageBlur = motion.uGanImageBlur;
      shader.uniforms.uGanImageMask = motion.uGanImageMask;
      shader.fragmentShader = IMAGE_MOTION_DEFS + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        IMAGE_MOTION_MAP,
      );
      opaque = `${opaque}\n${IMAGE_MOTION_MASK}`;
    }
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", opaque);
  };
  material.customProgramCacheKey = () =>
    motion
      ? `kookaburra-image-effects-v2:${shine ? "shine" : "plain"}:motion`
      : "kookaburra-image-shine-v1";
}

function LoadedImageCard({
  url,
  position,
  width,
  from,
  to,
}: {
  url: string;
  position: V3;
  width: number;
  from?: number;
  to?: number;
}) {
  const { localMs } = useTimeline();
  const group = useContext(GroupAnimationContext);
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  // Mount-stable (the resolved group animation cannot change without a scene remount).
  const shineCapable = group?.shineCapable === true;
  const motionCapable = group?.imageEffectsCapable === true;
  const shineUniforms = useMemo<ImageShineUniforms | null>(
    () =>
      shineCapable
        ? {
            uGanShine: { value: new Vector4(0, 1, 0, 0) },
            uGanShineAxis: { value: new Vector2(SHINE_AXIS[0], SHINE_AXIS[1]) },
            uGanSize: { value: new Vector2(1, 1) },
          }
        : null,
    [shineCapable],
  );
  const motionUniforms = useMemo<ImageMotionUniforms | null>(
    () =>
      motionCapable
        ? {
            uGanImageBlur: { value: new Vector4(0, 0, 0, 0) },
            uGanImageMask: { value: new Vector4(0, 1, 0.002, 0) },
          }
        : null,
    [motionCapable],
  );
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    m.map = texture;
    if (shineUniforms || motionUniforms) applyImageEffects(m, shineUniforms, motionUniforms);
    return m;
  }, [texture, shineUniforms, motionUniforms]);
  useLayoutEffect(() => () => material.dispose(), [material]);

  const img = texture.image as { width: number; height: number };
  const height = width * (img.height / img.width);
  const opacity =
    from === undefined || to === undefined || to <= from
      ? 1
      : Math.min(1, Math.max(0, (localMs - from) / (to - from)));
  // Group alpha multiplies in CPU-side (× 1 is fp-exact outside groups).
  material.opacity = opacity * (group?.alpha ?? 1);
  if (shineUniforms) {
    const band = foldBandToChild(group, position);
    if (band) {
      shineUniforms.uGanShine.value.set(band.centerS, band.invHalfWidthS, SHINE_INTENSITY, 1);
    } else {
      shineUniforms.uGanShine.value.set(0, 1, 0, 0);
    }
    shineUniforms.uGanSize.value.set(width, height);
  }
  if (motionUniforms) {
    const effects = groupImageEffects(group, width, height);
    if (effects) {
      motionUniforms.uGanImageBlur.value.fromArray(effects.blur);
      motionUniforms.uGanImageMask.value.fromArray(effects.mask);
    }
  }

  return (
    <mesh position={position} material={material}>
      <planeGeometry args={[width, height]} />
    </mesh>
  );
}
