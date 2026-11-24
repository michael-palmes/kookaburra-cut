import { type ReactNode, useEffect, useMemo } from "react";
import { resolveTokenFill } from "../../engine/textStyleResolve";
import { useTheme } from "../../theme";
import type { ExtrudedFinish } from "../text3d/ExtrudedText";
import type { V3 } from "../types";
import { slabGeometry } from "./slabGeometry";

export interface SlabProps {
  /** World-unit width and height of the face. */
  width?: number;
  height?: number;
  /** World-unit thickness. Defaults to half the smaller side. */
  depth?: number;
  /** Corner radius as a fraction of the smaller side: 0.5 (the default) makes a capsule. */
  radius?: number;
  /** Edge rounding as a fraction of the smaller side (0.12); towards 0.45 with a depth near the height it becomes a fully round pill. */
  bevel?: number;
  /** A theme colour token (`text`, `muted`, `accent`) or a hex colour. */
  color?: string;
  /** The surface (clearcoated by default, so it takes gloss from lights and the environment). */
  finish?: ExtrudedFinish;
  /** Cast and take the stage's shadows. */
  shadow?: boolean;
  position?: V3;
  /** Rotation in radians. */
  rotation?: V3;
  scale?: number;
  /** Drawn on the front face: a label, an icon. */
  children?: ReactNode;
}

/** How far in front of the face its children sit, as a share of the depth: clear of the surface at any angle a chip is shown from. */
export const SLAB_FACE_GAP = 0.02;

/** A thick, lit plate with rounded edges: a chip, a badge or a key standing in a scene, with whatever it carries (a label, an icon) drawn on its front face. It reflects in a satin floor and can cast a shadow. */
export function Slab({
  width = 1,
  height = 0.4,
  depth,
  radius = 0.5,
  bevel = 0.12,
  color = "text",
  finish,
  shadow = false,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  children,
}: SlabProps) {
  const theme = useTheme();
  const least = Math.min(width, height);
  const thickness = depth ?? least * 0.5;
  const geometry = useMemo(
    () => slabGeometry(width, height, thickness, radius * least, bevel * least),
    [width, height, thickness, radius, bevel, least],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <mesh geometry={geometry} castShadow={shadow} receiveShadow={shadow}>
        <meshPhysicalMaterial
          color={resolveTokenFill(theme, color)}
          roughness={finish?.roughness ?? 0.3}
          metalness={finish?.metalness ?? 0}
          clearcoat={finish?.clearcoat ?? 1}
          clearcoatRoughness={finish?.clearcoatRoughness ?? 0.3}
          envMapIntensity={finish?.envIntensity ?? 1}
        />
      </mesh>
      <group position={[0, 0, thickness * (0.5 + SLAB_FACE_GAP)]}>{children}</group>
    </group>
  );
}
