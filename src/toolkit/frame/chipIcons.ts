import { useTexture } from "@react-three/drei";
import { TextureLoader } from "three";
import circleCheck from "../../assets/icons/circle-check.png?url";
import circleX from "../../assets/icons/circle-x.png?url";
import clock from "../../assets/icons/clock.png?url";
import info from "../../assets/icons/info.png?url";
import star from "../../assets/icons/star.png?url";
import triangleAlert from "../../assets/icons/triangle-alert.png?url";

/** The curated chip icon set: Lucide (ISC) designs, pre-rasterised to bundled white-on-transparent PNGs and tinted at render, so exports stay byte-identical (no runtime SVG rasterisation, no system fonts). The inspector previews the same icons as inline SVGs. */
export const CHIP_ICON_TEXTURES = {
  "circle-check": circleCheck,
  "triangle-alert": triangleAlert,
  "circle-x": circleX,
  info,
  star,
  clock,
} as const;

export type ChipIconId = keyof typeof CHIP_ICON_TEXTURES;
export const CHIP_ICON_IDS = Object.keys(CHIP_ICON_TEXTURES) as ChipIconId[];

/** Shorthands that resolve to a set icon, so legacy `"✓"`/`"checkmark"` sidecars keep working. */
const ALIASES: Record<string, ChipIconId> = {
  "✓": "circle-check",
  "✔": "circle-check",
  checkmark: "circle-check",
  check: "circle-check",
};

/** Maps a chip icon string to a set id, or `null` when it's a custom emoji / asset path. */
export function resolveChipIconId(icon: string | undefined): ChipIconId | null {
  if (!icon) return null;
  if (icon in CHIP_ICON_TEXTURES) return icon as ChipIconId;
  return ALIASES[icon] ?? null;
}

/** Export-preamble barrier: warm drei's suspense cache and settle every chip icon texture before frame 0 (the `preloadProjectImages` pattern, for bundled assets). */
export async function preloadChipIcons(): Promise<void> {
  const loader = new TextureLoader();
  await Promise.all(
    Object.values(CHIP_ICON_TEXTURES).map(async (url) => {
      useTexture.preload(url);
      await loader.loadAsync(url);
    }),
  );
}
