#!/usr/bin/env node
/**
 * Convert the bundled WOFFs into three.js typeface JSONs for `ExtrudedText`
 * (FontLoader + TextGeometry need glyph outlines, not the SDF atlas troika builds).
 * The outputs are committed beside the WOFFs and bundled via direct JSON imports, so
 * the 3D-text path needs no fetch at runtime. One typeface per FAMILY (the default
 * weight) — 3D text is a display primitive; weights stay a 2D concern (v8 · M3).
 *
 * Usage: pnpm assets:text3d-font
 */
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";

// Keep in sync with BUNDLED_FONTS (src/theme/fonts.ts) + TYPEFACE_DATA (toolkit/text3d/fonts.ts).
const FONTS = [
  { src: "src/assets/fonts/Inter-Regular.woff", family: "Inter" },
  { src: "src/assets/fonts/SpaceGrotesk-Regular.woff", family: "Space Grotesk" },
  { src: "src/assets/fonts/OpenSans-Regular.woff", family: "Open Sans" },
  { src: "src/assets/fonts/JetBrainsMono-Regular.woff", family: "JetBrains Mono" },
];

// Keep in sync with PRELOAD_CHARACTERS in src/theme/fonts.ts — the same glyph
// coverage the 2D text primitives preload.
const CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?'\"()[]{}%-+/&@#";

const RESOLUTION = 1000;

function convert(SRC, FAMILY) {
  const OUT = SRC.replace(/\.woff$/, ".typeface.json");
  const buf = readFileSync(SRC);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  // facetype.js's scale (the converter behind three's stock fonts) — keeps TextGeometry's
  // `size` semantics identical to helvetiker et al.
  const scale = (RESOLUTION * 100) / (font.unitsPerEm * 72);
  const round = (v) => Math.round(v * scale);

  /** Serialize an opentype path to three's typeface outline string (end point first, then controls). */
  function outline(path) {
    const parts = [];
    for (const cmd of path.commands) {
      parts.push(cmd.type === "C" ? "b" : cmd.type.toLowerCase());
      if (cmd.x !== undefined) parts.push(round(cmd.x), round(cmd.y));
      if (cmd.x1 !== undefined) parts.push(round(cmd.x1), round(cmd.y1));
      if (cmd.x2 !== undefined) parts.push(round(cmd.x2), round(cmd.y2));
    }
    return parts.join(" ");
  }

  const glyphs = {};
  const missing = [];
  for (const char of new Set(CHARACTERS)) {
    const glyph = font.charToGlyph(char);
    if (!glyph || glyph.index === 0) {
      missing.push(char);
      continue;
    }
    const bounds = glyph.getBoundingBox(); // path-derived; zeros for empty glyphs (space)
    glyphs[char] = {
      ha: round(glyph.advanceWidth),
      x_min: round(bounds.x1),
      x_max: round(bounds.x2),
      o: outline(glyph.path),
    };
  }
  if (missing.length > 0) {
    console.warn(`[assets:text3d-font] no glyph for: ${missing.join(" ")}`);
  }

  const head = font.tables.head;
  const post = font.tables.post;
  const typeface = {
    glyphs,
    familyName: font.names.fontFamily?.en ?? FAMILY,
    ascender: round(font.ascender),
    descender: round(font.descender),
    underlinePosition: round(post?.underlinePosition ?? 0),
    underlineThickness: round(post?.underlineThickness ?? 0),
    boundingBox: {
      xMin: round(head.xMin),
      xMax: round(head.xMax),
      yMin: round(head.yMin),
      yMax: round(head.yMax),
    },
    resolution: RESOLUTION,
    cssFontWeight: "normal",
    cssFontStyle: "normal",
    original_font_information: {
      format: 0,
      fontFamily: font.names.fontFamily?.en ?? FAMILY,
      fontSubfamily: font.names.fontSubfamily?.en ?? "Regular",
      source: SRC,
    },
  };

  writeFileSync(OUT, JSON.stringify(typeface));
  console.log(
    `[assets:text3d-font] wrote ${OUT}: ${Object.keys(glyphs).length} glyphs, ` +
      `${(JSON.stringify(typeface).length / 1024).toFixed(1)} KB`,
  );
}

for (const { src, family } of FONTS) convert(src, family);
