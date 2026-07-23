#!/usr/bin/env node
// Bakes the tap-highlight animation into RGBA PNG frames for the ffmpeg overlay,
// one directory per STYLE (shape); frames are white with alpha-only falloff, and
// colour is applied at render time (ffmpeg colorchannelmixer) and in the preview
// (CSS gradients), so every style works in every colour. Emits both generated
// consumers: the include_bytes! style map + colour multipliers edit.rs embeds,
// and the style/colour lists the editor preview renders. This script is the
// single source of truth for style and colour data; only the motion curve is
// still hand-mirrored from src/editor/tapAnimation.ts. Maintainer-only; the
// output is committed. Run: node scripts/generate-tap-dot.mjs

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const TAP_ANIMATION_DURATION_MS = 550;
const TAP_DOT_FRAME_COUNT = 36;
const FPS = 60;
const SIZE = 256;
// The dot at scale 1 fills SIZE / headroom so the 1.12 pulse never clips; edit.rs mirrors this when sizing the overlay (TAP_DOT_CANVAS_HEADROOM).
const CANVAS_HEADROOM = 1.15;

// Styles: alpha stops as [t, alpha] with t a fraction of half the element (CSS
// closest-side), linearly interpolated like CSS does. The first style is the default.
const STYLES = [
  {
    id: "glow",
    label: "Soft glow",
    alphaStops: [
      [0, 0.95],
      [0.45, 0.55],
      [0.7, 0],
    ],
  },
  {
    id: "dot",
    label: "Dot",
    alphaStops: [
      [0, 0.95],
      [0.5, 0.95],
      [0.62, 0],
    ],
  },
  {
    id: "ring",
    label: "Ring",
    alphaStops: [
      [0, 0],
      [0.42, 0.05],
      [0.52, 0.9],
      [0.6, 0.9],
      [0.7, 0],
    ],
  },
  {
    id: "target",
    label: "Dot and ring",
    alphaStops: [
      [0, 0.95],
      [0.18, 0.95],
      [0.26, 0],
      [0.5, 0],
      [0.56, 0.9],
      [0.64, 0.9],
      [0.7, 0],
    ],
  },
];

// Colours: applied over the white frames as channel multipliers (render) and
// rgba gradients (preview). The first colour is the default.
const COLORS = [
  { id: "light", label: "Light", rgb: [255, 255, 255] },
  { id: "dark", label: "Dark", rgb: [17, 17, 17] },
  { id: "blue", label: "Blue", rgb: [64, 156, 255] },
  { id: "red", label: "Red", rgb: [255, 59, 48] },
  { id: "terracotta", label: "Terracotta", rgb: [226, 114, 91] },
];

const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

/** Mirror of tapAnimation.ts tapDotFrame(): pop-in, pulse, settle, fade. */
function tapDotFrame(p) {
  if (p < 0.15) {
    const t = easeOutCubic(p / 0.15);
    return { opacity: lerp(0, 0.9, t), scale: lerp(0.4, 1, t) };
  }
  if (p < 0.4) {
    const t = (p - 0.15) / 0.25;
    return { opacity: lerp(0.9, 0.75, t), scale: lerp(1, 1.12, t) };
  }
  if (p < 0.65) {
    const t = (p - 0.4) / 0.25;
    return { opacity: lerp(0.75, 0.6, t), scale: lerp(1.12, 1, t) };
  }
  const t = (p - 0.65) / 0.35;
  return { opacity: lerp(0.6, 0, t), scale: lerp(1, 0.92, t) };
}

/** Alpha at t, CSS-style linear interpolation between [t, alpha] stops. */
function sampleAlpha(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [t1, a1] = stops[i - 1];
    const [t2, a2] = stops[i];
    if (t <= t2) return lerp(a1, a2, (t - t1) / (t2 - t1));
  }
  return 0;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    rgba.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderFrame(style, index) {
  const elapsedMs = (index * 1000) / FPS;
  const p = elapsedMs > TAP_ANIMATION_DURATION_MS ? null : elapsedMs / TAP_ANIMATION_DURATION_MS;
  const { opacity, scale } = p === null ? { opacity: 0, scale: 1 } : tapDotFrame(p);
  const half = ((SIZE / CANVAS_HEADROOM) * scale) / 2;
  const centre = SIZE / 2;
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const r = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      const alpha = opacity * sampleAlpha(style.alphaStops, r / half);
      const at = (y * SIZE + x) * 4;
      rgba[at] = 255;
      rgba[at + 1] = 255;
      rgba[at + 2] = 255;
      rgba[at + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(SIZE, rgba);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(repoRoot, "src-tauri", "templates", "tapdot");
rmSync(outRoot, { recursive: true, force: true });

const rustStyleEntries = [];
for (const style of STYLES) {
  const dir = join(outRoot, style.id);
  mkdirSync(dir, { recursive: true });
  const names = [];
  for (let i = 0; i < TAP_DOT_FRAME_COUNT; i++) {
    const name = `tapdot_${String(i).padStart(2, "0")}.png`;
    writeFileSync(join(dir, name), renderFrame(style, i));
    names.push(name);
  }
  rustStyleEntries.push(
    [
      `    (`,
      `        "${style.id}",`,
      `        &[`,
      ...names.map((n) => `            include_bytes!("../templates/tapdot/${style.id}/${n}"),`),
      `        ],`,
      `    ),`,
    ].join("\n"),
  );
}

const mult = (v) => (v / 255).toFixed(6);
const rust = [
  "// GENERATED by scripts/generate-tap-dot.mjs. Do not edit by hand.",
  "",
  "/// The tap-highlight animation: (style id, one white alpha-falloff RGBA PNG per 60fps frame).",
  "/// The first style is the default.",
  "pub static TAP_DOT_STYLES: &[(&str, &[&[u8]])] = &[",
  ...rustStyleEntries,
  "];",
  "",
  "/// Tap colours as channel multipliers over the white frames (ffmpeg colorchannelmixer).",
  "/// The first colour is the default.",
  "pub static TAP_DOT_COLORS: &[(&str, [f64; 3])] = &[",
  ...COLORS.map((c) => `    ("${c.id}", [${c.rgb.map(mult).join(", ")}]),`),
  "];",
  "",
].join("\n");
writeFileSync(join(repoRoot, "src-tauri", "src", "tap_dot_frames.generated.rs"), rust);

const ts = [
  "// GENERATED by scripts/generate-tap-dot.mjs. Do not edit by hand.",
  "",
  "/** A tap-highlight style (shape): alpha stops over half the element, closest-side. */",
  "export interface TapStyle {",
  "  id: string;",
  "  label: string;",
  "  alphaStops: [number, number][];",
  "}",
  "",
  "/** A tap-highlight colour, applied to any style. */",
  "export interface TapColor {",
  "  id: string;",
  "  label: string;",
  "  rgb: [number, number, number];",
  "}",
  "",
  "export const TAP_STYLES: TapStyle[] = [",
  ...STYLES.flatMap((s) => [
    "  {",
    `    id: "${s.id}",`,
    `    label: "${s.label}",`,
    "    alphaStops: [",
    ...s.alphaStops.map(([t, a]) => `      [${t}, ${a}],`),
    "    ],",
    "  },",
  ]),
  "];",
  "",
  "export const TAP_COLORS: TapColor[] = [",
  ...COLORS.map((c) => `  { id: "${c.id}", label: "${c.label}", rgb: [${c.rgb.join(", ")}] },`),
  "];",
  "",
  `export const DEFAULT_TAP_STYLE_ID = "${STYLES[0].id}";`,
  `export const DEFAULT_TAP_COLOR_ID = "${COLORS[0].id}";`,
  "",
].join("\n");
writeFileSync(join(repoRoot, "src", "editor", "tapStyles.generated.ts"), ts);

console.log(
  `wrote ${STYLES.length} styles × ${TAP_DOT_FRAME_COUNT} frames and ${COLORS.length} colours to ${outRoot}, tap_dot_frames.generated.rs and tapStyles.generated.ts`,
);
