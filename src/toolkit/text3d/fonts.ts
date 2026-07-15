import { type Font, FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import interTypeface from "../../assets/fonts/Inter-Regular.typeface.json";
import jetbrainsMonoTypeface from "../../assets/fonts/JetBrainsMono-Regular.typeface.json";
import openSansTypeface from "../../assets/fonts/OpenSans-Regular.typeface.json";
import spaceGroteskTypeface from "../../assets/fonts/SpaceGrotesk-Regular.typeface.json";
import type { FontRef } from "../../theme/tokens";

/** Bundled typeface-JSON fonts for `ExtrudedText` (TextGeometry needs glyph outlines, not the SDF atlas troika uses, see scripts/prepare-text3d-font.mjs); keyed by the theme typography FAMILY, mirroring `theme/fonts.ts`, one typeface per family (3D text is a display primitive, so weights stay a 2D concern), with system fonts resolving to Inter here (outline conversion for pinned fonts is out of scope). The JSON is imported directly into the bundle and parsed synchronously, so 3D text needs no fetch at runtime. */
const TYPEFACE_DATA: Record<string, unknown> = {
  Inter: interTypeface,
  "Space Grotesk": spaceGroteskTypeface,
  "Open Sans": openSansTypeface,
  "JetBrains Mono": jetbrainsMonoTypeface,
};

const parsed = new Map<string, Font>();

/** Resolve a font reference to a parsed three `Font` (bundled families; else Inter). */
export function text3dFont(ref: FontRef | string): Font {
  const family = typeof ref === "string" ? ref : ref.family;
  const key = family in TYPEFACE_DATA ? family : "Inter";
  let font = parsed.get(key);
  if (!font) {
    font = new FontLoader().parse(TYPEFACE_DATA[key] as Parameters<FontLoader["parse"]>[0]);
    parsed.set(key, font);
  }
  return font;
}

/** Parses every bundled typeface before frame 0; synchronous today (the JSON is bundled), but kept async and awaited in the export preamble so the barrier survives a future move to fetched fonts. */
export async function preloadText3dFonts(): Promise<void> {
  for (const family of Object.keys(TYPEFACE_DATA)) {
    text3dFont(family);
  }
}
