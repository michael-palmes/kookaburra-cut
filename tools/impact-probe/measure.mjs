#!/usr/bin/env node
// Reads an impact-probe export frame by frame and writes each motion's measured landing time. Usage: measure.mjs <export.mp4> [--write]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
  readFileSync(join(ROOT, "fixtures/impact-probe/manifest.json"), "utf8"),
);
const video = process.argv[2];
if (!video) {
  console.error("usage: measure.mjs <export.mp4> [--write]");
  process.exit(2);
}

const FPS = 60;
const INK = 24;
const CLOSE = 0.02;
/** A size crossing only counts where the shape already overlaps its rest: a glyph turning through its final width isn't landing. */
const CROSSING_OVERLAP = 0.35;
const [width, height] = process.env.PROBE_SIZE?.split("x").map(Number) ?? [2622, 1206];

const frameMs = 1000 / FPS;
const sceneFrames = Math.round((manifest.sceneMs * FPS) / 1000);
const fromFrame = Math.round((manifest.fromMs * FPS) / 1000);

/** A row or column only counts toward the box when it carries this share of the busiest one, so a last sliver of a wipe can't hold the box open. */
const BOX_SHARE = 0.04;

function span(profile) {
  const peak = Math.max(...profile);
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] < peak * BOX_SHARE) continue;
    if (lo < 0) lo = i;
    hi = i;
  }
  return hi - lo + 1;
}

/** Ink stats against the scene's blank first frame: the box, the ink's weight and its centre. */
function stats(frame, blank) {
  let sum = 0;
  let cx = 0;
  let cy = 0;
  const rows = new Float64Array(height);
  const cols = new Float64Array(width);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const d = Math.abs(frame[i] - blank[i]);
      if (d < INK) continue;
      sum += d;
      cx += d * x;
      cy += d * y;
      rows[y] += d;
      cols[x] += d;
    }
  }
  return sum === 0
    ? { sum: 0, w: 0, h: 0, cx: 0, cy: 0 }
    : { sum, w: span(cols), h: span(rows), cx: cx / sum, cy: cy / sum };
}

function overlap(frame, restFrame, blank) {
  let both = 0;
  let either = 0;
  for (let i = 0; i < frame.length; i++) {
    const a = Math.abs(frame[i] - blank[i]) >= INK;
    const b = Math.abs(restFrame[i] - blank[i]) >= INK;
    if (a && b) both++;
    if (a || b) either++;
  }
  return either === 0 ? 0 : both / either;
}

function landingMs(rows, rest, firstInk, overlapAt) {
  if (firstInk) {
    const at = rows.findIndex((r) => r.sum > 0);
    return at < 0 ? null : at * frameMs;
  }
  const off = (r) => ({
    w: r.w / rest.w - 1,
    h: r.h / rest.h - 1,
    s: r.sum / rest.sum - 1,
    x: (r.cx - rest.cx) / rest.h,
    y: (r.cy - rest.cy) / rest.h,
  });
  for (let i = 0; i < rows.length; i++) {
    const o = off(rows[i]);
    const place = Math.max(Math.abs(o.x), Math.abs(o.y));
    if (Math.max(Math.abs(o.w), Math.abs(o.h), Math.abs(o.s), place) <= CLOSE) return i * frameMs;
    if (i > 0 && rows[i].sum >= 0.85 * rest.sum && place <= 2 * CLOSE) {
      const p = off(rows[i - 1]);
      if (rows[i - 1].sum >= 0.85 * rest.sum && p.w * o.w < 0 && overlapAt(i) >= CROSSING_OVERLAP) {
        return (i - 1 + Math.abs(p.w) / (Math.abs(p.w) + Math.abs(o.w))) * frameMs;
      }
    }
  }
  return null;
}

const ff = spawn(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    video,
    "-vf",
    `scale=${width}:${height},format=gray`,
    "-f",
    "rawvideo",
    "-",
  ],
  {
    stdio: ["ignore", "pipe", "inherit"],
  },
);

const frameBytes = width * height;
let carry = Buffer.alloc(0);
let frameIndex = 0;
let blank = null;
let rows = [];
let frames = [];
const results = {};

function finishScene(sceneIndex) {
  const entry = manifest.entries[sceneIndex];
  if (!entry) return;
  const rest = rows[rows.length - 1];
  const restFrame = frames[frames.length - 1];
  const inWindow = rows.slice(fromFrame);
  const ms = landingMs(inWindow, rest, entry.id === "typewriter", (i) =>
    overlap(frames[fromFrame + i], restFrame, blank),
  );
  results[entry.id] = ms === null ? null : Math.round(ms);
  console.log(`${entry.id.padEnd(16)} ${ms === null ? "never" : `${Math.round(ms)} ms`}`);
}

ff.stdout.on("data", (chunk) => {
  carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  while (carry.length >= frameBytes) {
    const frame = carry.subarray(0, frameBytes);
    const sceneIndex = Math.floor(frameIndex / sceneFrames);
    const local = frameIndex % sceneFrames;
    if (local === 0) {
      if (sceneIndex > 0) finishScene(sceneIndex - 1);
      blank = Buffer.from(frame);
      rows = [];
      frames = [];
    }
    frames.push(Buffer.from(frame));
    rows.push(stats(frame, blank));
    frameIndex++;
    carry = carry.subarray(frameBytes);
  }
});

ff.on("close", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  finishScene(Math.floor((frameIndex - 1) / sceneFrames));
  if (process.argv.includes("--write")) {
    const motions = {};
    const stamps = {};
    for (const { id, kind } of manifest.entries)
      (kind === "stamp" ? stamps : motions)[id] = results[id];
    const table = { windowMs: manifest.windowMs, ease: manifest.ease, fps: FPS, motions, stamps };
    writeFileSync(
      join(ROOT, "src/toolkit/text/textImpact.json"),
      `${JSON.stringify(table, null, 2)}\n`,
    );
    console.log("wrote src/toolkit/text/textImpact.json");
  }
});
