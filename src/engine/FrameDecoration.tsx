import { useTexture } from "@react-three/drei";
import { useContext, useLayoutEffect, useMemo } from "react";
import { MeshBasicMaterial, SRGBColorSpace, type Texture } from "three";
import { useEditorStore } from "../store/editorStore";
import type { FrameDecorationSpec } from "../toolkit/frame/types";
import { AssetBoundary } from "../toolkit/media/AssetBoundary";
import type { FormatInfo } from "../toolkit/types";
import { useHeldLocalMs } from "./presentHold";
import { resolveAssetUrl } from "./project";
import { ProjectIdContext } from "./sceneContext";
import { useTimeline } from "./timeline";

/** Layer draw order: "below" tucks behind the panel's editorial text, "above" (the default) draws over everything and may cross the cutout edge (the breakout). Both draw over the composited slide, so a decoration always sits above the cutout scene; true behind-the-cutout layering would need the slide pass split and is deferred (docs/overlays.md). The band base plus the array index gives each decoration a distinct order so array position controls front/back stacking within a layer (equal renderOrder would fall to object-creation id, which array reorders don't change). */
const RENDER_ORDER = { below: -1000, above: 1000 };

/** Crops a square plane to a disc via an SDF alpha on the raw plane uv (not the map uv), the `ImageCard` shine precedent; a pure function of uv, so AA is compile-stable. A circle decoration expects a roughly square source. */
function applyCircleMask(material: MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying vec2 vDecoUv;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vDecoUv = uv;",
    );
    shader.fragmentShader = `varying vec2 vDecoUv;\n${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      `#include <opaque_fragment>
      float decoD = length(vDecoUv - 0.5) - 0.5;
      gl_FragColor.a *= 1.0 - smoothstep(-0.01, 0.01, decoD);`,
    );
  };
  material.customProgramCacheKey = () => "kookaburra-frame-deco-circle-v1";
}

/** One overlay decoration: a positioned image in the panel, optionally cropped to a disc (avatars). Position is frame-relative (-1..1 on both axes), size is a fraction of the frame width. Unlit with `toneMapped: false` so the asset's pixels land exactly (the icon/backdrop precedent); the texture is drei-cached and never mutated, so sharing an asset across scenes stays safe. Settled by the export preamble (`preloadProjectImages`) before frame 0. See docs/overlays.md. */
export function FrameDecoration({
  decoration,
  format,
  from,
  to,
  order,
}: {
  decoration: FrameDecorationSpec;
  format: FormatInfo;
  from?: number;
  to?: number;
  /** Array index within the panel's decorations, added to the layer band for a stable front/back order. */
  order?: number;
}) {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  let url: string | null = null;
  try {
    url = resolveAssetUrl(projectId, decoration.src);
  } catch (e) {
    console.warn(`[frame] decoration "${decoration.src}" unresolved:`, e);
  }
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={decoration.src}>
      <LoadedDecoration
        url={url}
        decoration={decoration}
        format={format}
        from={from}
        to={to}
        order={order}
      />
    </AssetBoundary>
  );
}

function LoadedDecoration({
  url,
  decoration,
  format,
  from,
  to,
  order,
}: {
  url: string;
  decoration: FrameDecorationSpec;
  format: FormatInfo;
  from?: number;
  to?: number;
  order?: number;
}) {
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);

  const circle = decoration.shape === "circle";
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    m.map = texture;
    if (circle) applyCircleMask(m);
    return m;
  }, [texture, circle]);
  useLayoutEffect(() => () => material.dispose(), [material]);

  const img = texture.image as { width: number; height: number };
  const width = decoration.size * format.frame.width;
  const height = circle ? width : width * (img.height / img.width);
  const x = (decoration.position[0] * format.frame.width) / 2;
  const y = (decoration.position[1] * format.frame.height) / 2;
  // Clockwise on screen is negative about +z (the viewer looks down -z); 0/absent leaves the mesh upright.
  const rotZ = decoration.rotationDeg ? (-decoration.rotationDeg * Math.PI) / 180 : 0;
  const renderOrder =
    (decoration.layer === "below" ? RENDER_ORDER.below : RENDER_ORDER.above) + (order ?? 0);
  material.opacity =
    from === undefined || to === undefined || to <= from
      ? 1
      : Math.min(1, Math.max(0, (localMs - from) / (to - from)));

  return (
    <mesh
      position={[x, y, 0]}
      rotation={[0, 0, rotZ]}
      material={material}
      renderOrder={renderOrder}
    >
      <planeGeometry args={[width, height]} />
    </mesh>
  );
}
