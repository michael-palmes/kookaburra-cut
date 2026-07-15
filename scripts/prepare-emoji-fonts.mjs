#!/usr/bin/env node
/**
 * Build the bundled text-fallback face: Noto Sans Symbols 2 outlines (text-default
 * symbols like arrows, checks and stars) merged with 1024 empty private-use glyphs
 * (U+E000-E3FF) that reserve layout space for colour emoji quads. The face is wired
 * as troika's `defaultFontURL`, so it only ever resolves codepoints the theme font
 * lacks; every PUA codepoint maps to ONE shared empty glyph so the SDF atlas gains
 * a single cell regardless of how many emoji a project uses.
 *
 * Also emits src/theme/symbolsCodepoints.generated.ts so the routing table and the
 * committed font can never drift. Output must be byte-stable across reruns.
 *
 * Usage: pnpm assets:emoji-fonts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";

// Coverage is spread across three Noto faces (all OFL); each codepoint resolves from the first source that has it.
const SYMBOLS_SOURCES = [
  "node_modules/@fontsource/noto-sans-symbols-2/files/noto-sans-symbols-2-symbols-400-normal.woff",
  "node_modules/@fontsource/noto-sans-symbols/files/noto-sans-symbols-symbols-400-normal.woff",
  "node_modules/@fontsource/noto-sans-math/files/noto-sans-math-latin-400-normal.woff",
  "node_modules/@fontsource/noto-sans-symbols-2/files/noto-sans-symbols-2-latin-400-normal.woff",
];
const METRICS_SRC = "src/assets/fonts/Inter-Regular.woff";
const FONT_OUT = "src/assets/fonts/KookaburraFallback.otf";
const TS_OUT = "src/theme/symbolsCodepoints.generated.ts";
const COVERAGE_OUT = "src/theme/fontCoverage.generated.ts";

// Keep in sync with BUNDLED_FONTS (src/theme/fonts.ts); coverage unions all weights per family.
const BUNDLED_FAMILY_FILES = {
  Inter: ["src/assets/fonts/Inter-Regular.woff", "src/assets/fonts/Inter-SemiBold.woff"],
  "Space Grotesk": [
    "src/assets/fonts/SpaceGrotesk-Regular.woff",
    "src/assets/fonts/SpaceGrotesk-SemiBold.woff",
  ],
  "Open Sans": [
    "src/assets/fonts/OpenSans-Regular.woff",
    "src/assets/fonts/OpenSans-SemiBold.woff",
  ],
  "JetBrains Mono": ["src/assets/fonts/JetBrainsMono-Regular.woff"],
  "Playfair Display": ["src/assets/fonts/PlayfairDisplay-SemiBold.woff"],
  Lora: ["src/assets/fonts/Lora-Regular.woff"],
};

const EMOJI_PUA_START = 0xe000;
const EMOJI_PUA_COUNT = 1024;
// Layout advance reserved per emoji cluster, in em; ~Apple Color Emoji's real advance, so adjacent emoji art never collides.
const EMOJI_ADVANCE_EM = 1.25;

// Text-default symbols only: emoji-default codepoints render as colour quads instead.
const SYMBOL_CODEPOINTS = [
  // Arrows
  0x2190, 0x2191, 0x2192, 0x2193, 0x2194, 0x2195, 0x21a9, 0x21aa, 0x21ba, 0x21bb, 0x21d0, 0x21d1,
  0x21d2, 0x21d3, 0x21d4, 0x21e7,
  // Mac key symbols
  0x2303, 0x2318, 0x2325, 0x232b, 0x23ce,
  // Maths
  0x2212, 0x221e, 0x2248, 0x2260, 0x2264, 0x2265,
  // Geometric shapes
  0x25a0, 0x25a1, 0x25b2, 0x25b3, 0x25b6, 0x25b7, 0x25bc, 0x25bd, 0x25c0, 0x25c1, 0x25c6, 0x25c7,
  0x25ca, 0x25cb, 0x25cf, 0x25e6,
  // Misc symbols (ballot boxes cover the VS15/text form of the checkbox emoji)
  0x2605, 0x2606, 0x2610, 0x2611, 0x2612, 0x2660, 0x2663, 0x2665, 0x2666, 0x266a, 0x266b, 0x26a0,
  // Dingbats
  0x2713, 0x2714, 0x2715, 0x2716, 0x2717, 0x2718, 0x2726, 0x2727, 0x2736, 0x2764, 0x2794, 0x27a4,
];

function parseFont(path) {
  const buf = readFileSync(path);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const symbolsFonts = SYMBOLS_SOURCES.map(parseFont);
const metricsFont = parseFont(METRICS_SRC);

const upem = metricsFont.unitsPerEm;

/** Scale a source path into the target upem, preserving curve structure. */
function scaledPath(path, scale) {
  const out = new opentype.Path();
  for (const cmd of path.commands) {
    const c = { type: cmd.type };
    for (const k of ["x", "y", "x1", "y1", "x2", "y2"]) {
      if (cmd[k] !== undefined) c[k] = Math.round(cmd[k] * scale);
    }
    out.commands.push(c);
  }
  return out;
}

/** First source whose cmap actually covers the codepoint (the CSS ranges over-claim). */
function resolveSymbol(cp) {
  for (const font of symbolsFonts) {
    const glyph = font.charToGlyph(String.fromCodePoint(cp));
    if (glyph && glyph.index !== 0) return { glyph, scale: upem / font.unitsPerEm };
  }
  return null;
}

const notdef = new opentype.Glyph({
  name: ".notdef",
  advanceWidth: Math.round(upem / 2),
  path: new opentype.Path(),
});

const puaGlyph = new opentype.Glyph({
  name: "emojiPlaceholder",
  advanceWidth: Math.round(upem * EMOJI_ADVANCE_EM),
  path: new opentype.Path(),
  unicodes: Array.from({ length: EMOJI_PUA_COUNT }, (_, i) => EMOJI_PUA_START + i),
});

const glyphs = [notdef, puaGlyph];
const included = [];
const missing = [];
for (const cp of SYMBOL_CODEPOINTS) {
  const source = resolveSymbol(cp);
  if (!source) {
    missing.push(cp);
    continue;
  }
  glyphs.push(
    new opentype.Glyph({
      name: `uni${cp.toString(16).toUpperCase().padStart(4, "0")}`,
      unicode: cp,
      advanceWidth: Math.round(source.glyph.advanceWidth * source.scale),
      path: scaledPath(source.glyph.path, source.scale),
    }),
  );
  included.push(cp);
}
if (missing.length > 0) {
  console.warn(
    `[assets:emoji-fonts] source lacks: ${missing.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(" ")}`,
  );
}

const font = new opentype.Font({
  familyName: "Kookaburra Fallback",
  styleName: "Regular",
  unitsPerEm: upem,
  ascender: metricsFont.ascender,
  descender: metricsFont.descender,
  glyphs,
  // Pinned so regeneration is byte-stable.
  createdTimestamp: 0,
});

// opentype.js stamps head.modified from the wall clock with no pin option; freeze Date during serialisation so regeneration is byte-stable (createdTimestamp only pins head.created).
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor() {
    super(0);
  }
};
let fontBytes;
try {
  fontBytes = Buffer.from(font.toArrayBuffer());
} finally {
  globalThis.Date = RealDate;
}
writeFileSync(FONT_OUT, fontBytes);

const hex = (cp) => `0x${cp.toString(16)}`;
const preload =
  `"\\u${EMOJI_PUA_START.toString(16)}" +\n  ` +
  `"${included.map((cp) => `\\u${cp.toString(16).padStart(4, "0")}`).join("")}"`;
const ts = `// GENERATED by scripts/prepare-emoji-fonts.mjs. Do not edit by hand.

/** First private-use codepoint reserved for emoji placeholder substitution. */
export const EMOJI_PUA_START = ${hex(EMOJI_PUA_START)};

/** Number of reserved placeholder codepoints (one per distinct emoji cluster in a string). */
export const EMOJI_PUA_COUNT = ${EMOJI_PUA_COUNT};

/** Text-default symbol codepoints the bundled fallback face covers with real outlines. */
export const SYMBOLS_CODEPOINTS: ReadonlySet<number> = new Set([
  ${included.map(hex).join(", ")},
]);

/** Every fallback glyph warmed before frame 0: the shared emoji placeholder cell plus each symbol. */
export const FALLBACK_PRELOAD_CHARACTERS =
  ${preload};
`;
writeFileSync(TS_OUT, ts);

// Per-family cmap coverage for the inspector's unrenderable-character check.
const coverageEntries = Object.entries(BUNDLED_FAMILY_FILES).map(([family, files]) => {
  const cps = new Set();
  for (const file of files) {
    const font = parseFont(file);
    for (const k of Object.keys(font.tables.cmap.glyphIndexMap)) cps.add(Number(k));
  }
  const sorted = [...cps].sort((a, b) => a - b);
  return `  "${family}": new Set([${sorted.map(hex).join(", ")}]),`;
});
const coverageTs = `// GENERATED by scripts/prepare-emoji-fonts.mjs. Do not edit by hand.

/** Codepoints each bundled family's cmap covers (weights unioned); workspace-pinned families are absent and disable the check. */
export const BUNDLED_FONT_COVERAGE: Readonly<Record<string, ReadonlySet<number>>> = {
${coverageEntries.join("\n")}
};
`;
writeFileSync(COVERAGE_OUT, coverageTs);

// Canonical formatting so regeneration never trips lint.
execFileSync("pnpm", ["exec", "biome", "format", "--write", TS_OUT, COVERAGE_OUT], {
  stdio: "ignore",
});

console.log(
  `[assets:emoji-fonts] wrote ${FONT_OUT}: ${glyphs.length} glyphs ` +
    `(${included.length} symbols + placeholder), ${(fontBytes.byteLength / 1024).toFixed(1)} KB`,
);
