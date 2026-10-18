import { useTexture } from "@react-three/drei";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  type BufferAttribute,
  type Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
} from "three";
import { registerClip } from "../../engine/clips";
import { useClipTexture } from "../../engine/clipTexture";
import { frameAtDepth, useFormat } from "../../engine/format";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
import { resolveAssetPath } from "../../engine/project";
import { ProjectIdContext, SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import type { SceneDocMosaicReveal, SceneDocMosaicTile } from "../../engine/sceneDocSchema";
import {
  MOSAIC_DEFAULT_GAP,
  MOSAIC_REVEAL_FROM_SCALE,
  mosaicGrid,
  mosaicRevealEndMs,
  mosaicRevealRanks,
  mosaicTileKind,
  mosaicTileRects,
  mosaicTileReveal,
  type ResolvedMosaicReveal,
  resolveMosaic,
  resolveMosaicReveal,
  resolveSceneColour,
  useMosaicRegistry,
  useSceneConsumesMosaic,
} from "../../engine/sceneMosaic";
import { coverCropRect, remapUv } from "../../engine/screenFit";
import { useTimeline } from "../../engine/timeline";
import { useProjectAssetUrl } from "../../engine/useProjectAssetUrl";
import { useEditorStore } from "../../store/editorStore";
import { useTheme } from "../../theme";
import { AssetBoundary } from "../media/AssetBoundary";
import { lerp } from "../motion/math";
import type { V3 } from "../types";

/** Behind content at z = 0, so text laid out there draws over the field. */
const SPLIT_FIELD_Z = -0.05;

export type SplitFieldTile = SceneDocMosaicTile;

export interface SplitFieldProps {
  /** The tiles, in reading order; absent draws the sidecar `mosaic` block. */
  tiles?: SplitFieldTile[];
  /** Fixed column count; absent picks the most square grid for the aspect, so the field reflows. */
  columns?: number;
  /** Gap between tiles as a fraction of the field's short side (default 0.02). */
  gap?: number;
  reveal?: SceneDocMosaicReveal;
  /** Field size in world units (default the whole frame at the field's depth). */
  width?: number;
  height?: number;
  /** Default [0, 0, -0.05], just behind content at z = 0. */
  position?: V3;
}

interface TileDraw {
  tile: SplitFieldTile;
  width: number;
  height: number;
  position: V3;
  reveal: number;
}

/** Cover-fits media into a tile through the plane's UVs (the Device screen precedent), rebuilt only when either aspect changes. */
function useCoverGeometry(mediaAspect: number, tileAspect: number): PlaneGeometry {
  const geometry = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    const crop = coverCropRect(mediaAspect, tileAspect, false);
    const uv = g.attributes.uv as BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const [u, v] = remapUv(uv.getX(i), uv.getY(i), crop);
      uv.setXY(i, u, v);
    }
    return g;
  }, [mediaAspect, tileAspect]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

function revealScale(reveal: number): number {
  return lerp(MOSAIC_REVEAL_FROM_SCALE, 1, reveal);
}

function useTileMaterial(): MeshBasicMaterial {
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    return m;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

function ColourTile({ draw }: { draw: TileDraw }) {
  const theme = useTheme();
  const material = useTileMaterial();
  material.color.set(resolveSceneColour(draw.tile.colour, theme.colors, "muted"));
  material.opacity = Math.min(1, Math.max(0, draw.reveal));
  const s = revealScale(draw.reveal);
  return (
    <mesh
      position={draw.position}
      scale={[draw.width * s, draw.height * s, 1]}
      material={material}
      visible={draw.reveal > 0}
    >
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

function LoadedImageTile({ draw, url }: { draw: TileDraw; url: string }) {
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  const material = useTileMaterial();
  if (material.map !== texture) {
    material.map = texture;
    material.needsUpdate = true;
  }
  material.opacity = Math.min(1, Math.max(0, draw.reveal));
  const img = texture.image as { width: number; height: number };
  const geometry = useCoverGeometry(
    img.width > 0 && img.height > 0 ? img.width / img.height : 1,
    draw.height > 0 ? draw.width / draw.height : 1,
  );
  const s = revealScale(draw.reveal);
  return (
    <mesh
      position={draw.position}
      scale={[draw.width * s, draw.height * s, 1]}
      material={material}
      geometry={geometry}
      visible={draw.reveal > 0}
    />
  );
}

function ImageTile({ draw }: { draw: TileDraw }) {
  const src = draw.tile.src as string;
  const url = useProjectAssetUrl(src, "[mosaic]");
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={src}>
      <LoadedImageTile draw={draw} url={url} />
    </AssetBoundary>
  );
}

function VideoTile({ draw }: { draw: TileDraw }) {
  const meshRef = useRef<Mesh>(null);
  const material = useTileMaterial();
  // Hidden until the first frame binds; the reveal rides opacity so it never fights that switch.
  const onPending = useCallback(() => {
    if (meshRef.current) meshRef.current.visible = false;
  }, []);
  const onBound = useCallback(() => {
    if (meshRef.current) meshRef.current.visible = true;
  }, []);
  const { info } = useClipTexture({
    src: draw.tile.src as string,
    startMs: draw.tile.startMs ?? 0,
    loop: draw.tile.loop === true,
    material,
    readyObjectRef: meshRef,
    onPending,
    onBound,
  });
  material.opacity = Math.min(1, Math.max(0, draw.reveal));
  const geometry = useCoverGeometry(
    info && info.width > 0 && info.height > 0 ? info.width / info.height : 1,
    draw.height > 0 ? draw.width / draw.height : 1,
  );
  const s = revealScale(draw.reveal);
  return (
    <mesh
      ref={meshRef}
      position={draw.position}
      scale={[draw.width * s, draw.height * s, 1]}
      material={material}
      geometry={geometry}
    />
  );
}

function Tile({ draw }: { draw: TileDraw }) {
  switch (mosaicTileKind(draw.tile)) {
    case "image":
      return <ImageTile draw={draw} />;
    case "video":
      return <VideoTile draw={draw} />;
    default:
      return <ColourTile draw={draw} />;
  }
}

/** The field itself, no registration: shared by `SplitField` and the host fallback. */
function MountedSplitField({
  tiles,
  columns,
  gap,
  reveal,
  width,
  height,
  position,
}: {
  tiles: SplitFieldTile[];
  columns?: number;
  gap: number;
  reveal: ResolvedMosaicReveal;
  width?: number;
  height?: number;
  position?: V3;
}) {
  const format = useFormat();
  const { localMs } = useTimeline();
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  // Video tiles register here, before an image tile can suspend the subtree, so a cold export's extract barrier already knows them.
  for (const tile of tiles) {
    if (mosaicTileKind(tile) === "video") {
      registerClip(resolveAssetPath(contextProjectId ?? storeProjectId, tile.src as string));
    }
  }
  const origin: V3 = position ?? [0, 0, SPLIT_FIELD_Z];
  const frame = frameAtDepth(format, origin[2]);
  const area = { width: width ?? frame.width, height: height ?? frame.height };
  const grid = mosaicGrid(tiles.length, area.height > 0 ? area.width / area.height : 1, columns);
  const rects = mosaicTileRects(
    tiles.length,
    area,
    grid,
    Math.max(0, gap) * Math.min(area.width, area.height),
  );
  const ranks = mosaicRevealRanks(rects, reveal.order);
  const sceneIndex = useSceneContext()?.index;
  const settleMs = mosaicRevealEndMs(ranks, reveal);
  useEffect(() => {
    if (sceneIndex === undefined) return;
    return registerPresentTiming(sceneIndex, { kind: "decoration", toMs: settleMs });
  }, [sceneIndex, settleMs]);
  return (
    <group position={origin}>
      {tiles.map((tile, i) => (
        <Tile
          // biome-ignore lint/suspicious/noArrayIndexKey: tiles are positional (reading order), with no ids
          key={i}
          draw={{
            tile,
            width: rects[i].width,
            height: rects[i].height,
            position: [rects[i].x, rects[i].y, 0],
            reveal: mosaicTileReveal(localMs, ranks[i], reveal),
          }}
        />
      ))}
    </group>
  );
}

/** A frame split into tiles (project images, videos or theme colours) with a staggered reveal; the grid reflows per aspect unless `columns` fixes it. Without `tiles` it draws the sidecar `mosaic` block, and mounting it stands the host fallback down. */
export function SplitField(props: SplitFieldProps) {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useMosaicRegistry.getState().register(sceneIndex);
    return () => useMosaicRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex]);
  const block = props.tiles === undefined ? doc?.mosaic : undefined;
  const tiles = props.tiles ?? block?.tiles;
  if (!tiles || tiles.length === 0) return null;
  return (
    <MountedSplitField
      tiles={tiles}
      columns={props.columns ?? block?.columns}
      gap={props.gap ?? block?.gap ?? MOSAIC_DEFAULT_GAP}
      reveal={resolveMosaicReveal(block?.reveal, props.reveal)}
      width={props.width}
      height={props.height}
      position={props.position}
    />
  );
}

/** Host-side mosaic for scenes whose TSX never places a `SplitField` (mounted by the scene host, the ChartFallback pattern). */
export function MosaicFallback() {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  const consumed = useSceneConsumesMosaic(sceneIndex);
  const mosaic = useMemo(() => resolveMosaic(doc?.mosaic), [doc]);
  if (consumed || !mosaic) return null;
  return (
    <MountedSplitField
      tiles={mosaic.tiles}
      columns={mosaic.columns}
      gap={mosaic.gap}
      reveal={mosaic.reveal}
    />
  );
}
