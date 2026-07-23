#!/usr/bin/env node
// Bakes the tap-highlight glow-dot animation into RGBA PNG frames for the ffmpeg
// overlay, one directory per style preset, plus BOTH generated consumers: the
// include_bytes! preset map edit.rs embeds and the preset list (with CSS
// gradients) the editor preview renders. This script is the single source of
// truth for preset data; only the motion curve is still hand-mirrored from
// src/editor/tapAnimation.ts. Maintainer-only; the output is committed.
// Run: node scripts/generate-tap-dot.mjs

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

// Style presets: radial-gradient stops as [t, r, g, b, a] with t a fraction of
// half the element (CSS closest-side), linearly interpolated like CSS does.
// The first preset is the default.
const PRESETS = [
  {
    id: "glow-light",
    label: "Soft glow, light",
    stops: [
      [0, 255, 255, 255, 0.95],
      [0.45, 255, 255, 255, 0.55],
      [0.7, 255, 255, 255, 0],
    ],
  },
  {
    id: "glow-dark",
    label: "Soft glow, dark",
    stops: [
      [0, 17, 17, 17, 0.85],
      [0.42, 17, 17, 17, 0.6],
      [0.54, 255, 255, 255, 0.7],
      [0.7, 255, 255, 255, 0],
    ],
  },
  {
    id: "glow-blue",
    label: "Soft glow, blue",
    stops: [
      [0, 64, 156, 255, 0.95],
      [0.45, 64, 156, 255, 0.6],
      [0.7, 64, 156, 255, 0],
    ],
  },
  {
    id: "glow-red",
    label: "Soft glow, red",
    stops: [
      [0, 255, 59, 48, 0.95],
      [0.45, 255, 59, 48, 0.6],
      [0.7, 255, 59, 48, 0],
    ],
  },
  {
    id: "glow-terracotta",
    label: "Soft glow, terracotta",
    stops: [
      [0, 226, 114, 91, 0.95],
      [0.45, 226, 114, 91, 0.6],
      [0.7, 226, 114, 91, 0],
    ],
  },
  {
    id: "ring-light",
    label: "Ring, light",
    stops: [
      [0, 255, 255, 255, 0],
      [0.42, 255, 255, 255, 0.05],
      [0.52, 255, 255, 255, 0.9],
      [0.6, 255, 255, 255, 0.9],
      [0.7, 255, 255, 255, 0],
    ],
  },
  {
    id: "ring-dark",
    label: "Ring, dark",
    stops: [
      [0, 17, 17, 17, 0],
      [0.42, 17, 17, 17, 0.06],
      [0.52, 17, 17, 17, 0.92],
      [0.6, 17, 17, 17, 0.88],
      [0.7, 17, 17, 17, 0],
    ],
  },
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

/** Colour+alpha at t, CSS-style linear interpolation between stops. */
function sampleStops(stops, t) {
  if (t <= stops[0][0]) return stops[0].slice(1);
  for (let i = 1; i < stops.length; i++) {
    const [t1, ...c1] = stops[i - 1];
    const [t2, ...c2] = stops[i];
    if (t <= t2) {
      const k = (t - t1) / (t2 - t1);
      return c1.map((v, j) => lerp(v, c2[j], k));
    }
  }
  return [0, 0, 0, 0];
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

function renderFrame(preset, index) {
  const elapsedMs = (index * 1000) / FPS;
  const p = elapsedMs > TAP_ANIMATION_DURATION_MS ? null : elapsedMs / TAP_ANIMATION_DURATION_MS;
  const { opacity, scale } = p === null ? { opacity: 0, scale: 1 } : tapDotFrame(p);
  const half = ((SIZE / CANVAS_HEADROOM) * scale) / 2;
  const centre = SIZE / 2;
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const r = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      const [cr, cg, cb, ca] = sampleStops(preset.stops, r / half);
      const at = (y * SIZE + x) * 4;
      rgba[at] = Math.round(cr);
      rgba[at + 1] = Math.round(cg);
      rgba[at + 2] = Math.round(cb);
      rgba[at + 3] = Math.round(opacity * ca * 255);
    }
  }
  return encodePng(SIZE, rgba);
}

function cssGradient(stops) {
  const parts = stops.map(
    ([t, r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${a}) ${Math.round(t * 100)}%`,
  );
  return `radial-gradient(circle closest-side, ${parts.join(", ")})`;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(repoRoot, "src-tauri", "templates", "tapdot");
rmSync(outRoot, { recursive: true, force: true });

const rustEntries = [];
for (const preset of PRESETS) {
  const dir = join(outRoot, preset.id);
  mkdirSync(dir, { recursive: true });
  const names = [];
  for (let i = 0; i < TAP_DOT_FRAME_COUNT; i++) {
    const name = `tapdot_${String(i).padStart(2, "0")}.png`;
    writeFileSync(join(dir, name), renderFrame(preset, i));
    names.push(name);
  }
  rustEntries.push(
    [
      `    (`,
      `        "${preset.id}",`,
      `        &[`,
      ...names.map((n) => `            include_bytes!("../templates/tapdot/${preset.id}/${n}"),`),
      `        ],`,
      `    ),`,
    ].join("\n"),
  );
}

const rust = [
  "// GENERATED by scripts/generate-tap-dot.mjs. Do not edit by hand.",
  "",
  "/// The tap-highlight glow-dot animation: (preset id, one RGBA PNG per 60fps frame).",
  "/// The first preset is the default style.",
  "pub static TAP_DOT_PRESETS: &[(&str, &[&[u8]])] = &[",
  ...rustEntries,
  "];",
  "",
].join("\n");
writeFileSync(join(repoRoot, "src-tauri", "src", "tap_dot_frames.generated.rs"), rust);

const ts = [
  "// GENERATED by scripts/generate-tap-dot.mjs. Do not edit by hand.",
  "",
  "/** A tap-highlight style: the preview gradient matches the baked ffmpeg frames. */",
  "export interface TapPreset {",
  "  id: string;",
  "  label: string;",
  "  gradient: string;",
  "}",
  "",
  "export const TAP_PRESETS: TapPreset[] = [",
  ...PRESETS.flatMap((p) => {
    const gradient = cssGradient(p.stops);
    const inline = `    gradient: "${gradient}",`;
    const gradientLines =
      inline.length <= 100 ? [inline] : ["    gradient:", `      "${gradient}",`];
    return ["  {", `    id: "${p.id}",`, `    label: "${p.label}",`, ...gradientLines, "  },"];
  }),
  "];",
  "",
  `export const DEFAULT_TAP_PRESET_ID = "${PRESETS[0].id}";`,
  "",
].join("\n");
writeFileSync(join(repoRoot, "src", "editor", "tapPresets.generated.ts"), ts);

console.log(
  `wrote ${PRESETS.length} presets × ${TAP_DOT_FRAME_COUNT} frames to ${outRoot}, tap_dot_frames.generated.rs and tapPresets.generated.ts`,
);
