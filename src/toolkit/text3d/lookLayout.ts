/** Pure layout and material maths for the 3D text looks (glass-3d / chrome-3d): the extruded twin's anchor mapping and material parameter pricing, kept free of three imports so the seams test without a GL context. */

// ── Contract constants (golden-pinned; changing any re-renders every project that uses a 3D look) ──
/** Extrusion depth as a fraction of the font size (the ExtrudedText default). */
export const LOOK3D_DEPTH_EM = 0.25;
export const GLASS_ROUGHNESS = 0.15;
export const GLASS_IOR = 1.5;
/** glass thickness in em at intensity 0 and 1. */
export const GLASS_THICKNESS_MIN_EM = 0.15;
export const GLASS_THICKNESS_MAX_EM = 0.75;
export const CHROME_ROUGHNESS = 0.12;

/** Map troika's anchor semantics onto the extruded geometry's bounding box: the returned translation puts the anchor point at the local origin (X left/center/right, Y top/middle/bottom against the INK box, an approximation of troika's layout box), with the depth axis centred so the extruded body straddles the flat text's glyph plane. */
export function anchorShift(
  bbox: readonly [number, number, number, number, number, number],
  anchorX: "left" | "center" | "right",
  anchorY: "top" | "middle" | "bottom",
): [number, number, number] {
  const [minX, minY, minZ, maxX, maxY, maxZ] = bbox;
  const x = anchorX === "left" ? -minX : anchorX === "right" ? -maxX : -(minX + maxX) / 2;
  const y = anchorY === "top" ? -maxY : anchorY === "bottom" ? -minY : -(minY + maxY) / 2;
  return [x, y, -(minZ + maxZ) / 2];
}

/** glass-3d's MeshPhysicalMaterial parameters; intensity scales the transmission thickness. */
export function glassMaterialParams(
  intensity: number,
  fontSize: number,
  color: string,
): { color: string; transmission: number; roughness: number; ior: number; thickness: number } {
  return {
    color,
    transmission: 1,
    roughness: GLASS_ROUGHNESS,
    ior: GLASS_IOR,
    thickness:
      fontSize *
      (GLASS_THICKNESS_MIN_EM + (GLASS_THICKNESS_MAX_EM - GLASS_THICKNESS_MIN_EM) * intensity),
  };
}

/** chrome-3d's MeshStandardMaterial parameters: env-driven mirror metal, colorA-tinted. */
export function chromeMaterialParams(color: string): {
  color: string;
  metalness: number;
  roughness: number;
} {
  return { color, metalness: 1, roughness: CHROME_ROUGHNESS };
}
