import { useTexture } from "@react-three/drei";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { type BufferGeometry, ExtrudeGeometry, Shape, SRGBColorSpace, type Texture } from "three";
import { useProjectAssetUrl } from "../../engine/useProjectAssetUrl";
import type { ExtrudedFinish } from "../text3d/ExtrudedText";
import { smoothExtrudeNormals } from "../text3d/extrudeNormals";
import type { V3 } from "../types";
import { AssetBoundary } from "./AssetBoundary";

export interface IconTileProps {
  /** Project-relative image path (e.g. `assets/app-icon.png`). */
  src: string;
  position?: V3;
  /** Rotation in radians. */
  rotation?: V3;
  /** World-unit width and height of the tile's face. */
  size?: number;
  /** World-unit thickness. Defaults to `size * 0.28`. */
  depth?: number;
  /** Corner radius as a fraction of `size` (0.225, an app icon's corner). */
  radius?: number;
  /** Edge rounding as a fraction of `size` (0.035). */
  bevel?: number;
  /** The surface (clearcoated by default, so it takes gloss from area lights and the environment). */
  finish?: ExtrudedFinish;
  /** Cast and take the stage's shadows. */
  shadow?: boolean;
}

/** How far in from the image's edge the tile's rim samples, so the sides take the icon's border colour and never its transparent corners. */
export const ICON_TILE_INSET = 0.94;

/** A rounded slab whose every vertex maps straight through onto the image: the face shows the icon and the rim and sides carry its edge colour. */
export function iconTileGeometry(
  size: number,
  depth: number,
  radius: number,
  bevel: number,
): BufferGeometry {
  const edge = Math.min(Math.max(bevel, 0), 0.2) * size;
  const half = size / 2 - edge;
  const r = Math.min(Math.max(radius * size - edge, 0), half);
  const shape = new Shape();
  shape.moveTo(-half + r, -half);
  shape.lineTo(half - r, -half);
  shape.absarc(half - r, -half + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(half, half - r);
  shape.absarc(half - r, half - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-half + r, half);
  shape.absarc(-half + r, half - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-half, -half + r);
  shape.absarc(-half + r, -half + r, r, Math.PI, Math.PI * 1.5, false);
  const geometry = new ExtrudeGeometry(shape, {
    depth: Math.max(depth - 2 * edge, 0.0001),
    curveSegments: 16,
    bevelEnabled: edge > 0,
    bevelSize: edge,
    bevelThickness: edge,
    bevelSegments: 6,
  });
  geometry.center();
  const positions = geometry.getAttribute("position");
  const uvs = geometry.getAttribute("uv");
  for (let i = 0; i < positions.count; i++) {
    uvs.setXY(
      i,
      0.5 + (positions.getX(i) / size) * ICON_TILE_INSET,
      0.5 + (positions.getY(i) / size) * ICON_TILE_INSET,
    );
  }
  uvs.needsUpdate = true;
  if (edge <= 0) return geometry;
  const smooth = smoothExtrudeNormals(geometry);
  if (smooth !== geometry) geometry.dispose();
  return smooth;
}

/** An app icon as a thick, lit tile that stands on a stage: unlike the flat `ImageCard` it has depth, rounded edges and a glossy surface, shows in a floor's reflection and can cast a shadow. */
export function IconTile(props: IconTileProps) {
  const url = useProjectAssetUrl(props.src, "[icon tile]");
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={props.src}>
      <LoadedIconTile {...props} url={url} />
    </AssetBoundary>
  );
}

function LoadedIconTile({
  url,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  size = 1,
  depth,
  radius = 0.225,
  bevel = 0.035,
  finish,
  shadow = false,
}: IconTileProps & { url: string }) {
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  const thickness = depth ?? size * 0.28;
  const geometry = useMemo(
    () => iconTileGeometry(size, thickness, radius, bevel),
    [size, thickness, radius, bevel],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
      position={position}
      rotation={rotation}
      castShadow={shadow}
      receiveShadow={shadow}
    >
      <meshPhysicalMaterial
        map={texture}
        roughness={finish?.roughness ?? 0.3}
        metalness={finish?.metalness ?? 0}
        clearcoat={finish?.clearcoat ?? 1}
        clearcoatRoughness={finish?.clearcoatRoughness ?? 0.08}
      />
    </mesh>
  );
}
