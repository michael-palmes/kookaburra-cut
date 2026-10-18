import { describe, expect, it } from "vitest";
import type { DeviceMediaSpec } from "../toolkit/device/Device";
import {
  allChunks,
  CHUNK_FRAMES,
  chunkCount,
  chunkOf,
  chunksForFrames,
  windowChunks,
} from "./clipChunks";
import { clipFrameIndex, deviceClipFrameIndex } from "./clipFrame";

/** Mulberry32: a seeded generator so the sampled cases are the same every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every chunk the mapping reaches on a 0.05 ms grid: far finer than any frame lasts. */
function bruteForce(frameAt: (ms: number) => number, from: number, to: number, n: number) {
  const out = new Set<number>();
  for (let ms = from; ms <= to; ms += 0.05)
    out.add(chunkOf(Math.min(n - 1, Math.max(0, frameAt(ms)))));
  out.add(chunkOf(Math.min(n - 1, Math.max(0, frameAt(to)))));
  return [...out].sort((a, b) => a - b);
}

function sampled(frameAt: (ms: number) => number, from: number, to: number, n: number) {
  const out = new Set<number>();
  windowChunks(frameAt, from, to, n, out);
  return [...out].sort((a, b) => a - b);
}

describe("clip chunks", () => {
  it("tile the clip in fixed 120-frame chunks", () => {
    expect(CHUNK_FRAMES).toBe(120);
    expect(chunkCount(0)).toBe(0);
    expect(chunkCount(301)).toBe(3);
    expect(allChunks(241)).toEqual([0, 1, 2]);
    expect(chunksForFrames([0, 119, 120, 5000, -3], 300)).toEqual(new Set([0, 1, 2]));
  });

  it("match a dense scan for the VideoClip mapping, held or looping", () => {
    const next = rng(7);
    for (let i = 0; i < 60; i++) {
      const n = 1 + Math.floor(next() * 900);
      const startMs = Math.round((next() - 0.3) * 8000);
      const loop = next() < 0.5;
      const duration = 200 + Math.round(next() * 9000);
      const frameAt = (ms: number) => clipFrameIndex(ms, startMs, 60, n, loop);
      expect(sampled(frameAt, -500, duration + 500, n)).toEqual(
        bruteForce(frameAt, -500, duration + 500, n),
      );
    }
  });

  it("match a dense scan for retimed device screens up to 16x", () => {
    const next = rng(11);
    for (let i = 0; i < 60; i++) {
      const n = 120 + Math.floor(next() * 1500);
      const inMs = Math.round(next() * 4000);
      const media: DeviceMediaSpec = {
        src: "assets/a.mp4",
        kind: "video",
        startMs: Math.round(next() * 1500),
        inMs,
        outMs: next() < 0.5 ? inMs + 500 + Math.round(next() * 9000) : undefined,
        speed: [0.25, 0.5, 1, 1.5, 2, 6, 16][Math.floor(next() * 7)],
        loop: next() < 0.5,
        posterMs: next() < 0.3 ? Math.round(next() * 20000) : undefined,
      };
      const offset = next() < 0.3 ? next() * 3000 : 0;
      const duration = 300 + Math.round(next() * 6000);
      const frameAt = (ms: number) => deviceClipFrameIndex(ms, offset, media, 60, n);
      expect(sampled(frameAt, -500, duration + 500, n)).toEqual(
        bruteForce(frameAt, -500, duration + 500, n),
      );
    }
  });

  it("take every chunk for a window too long to sample (a Present hold)", () => {
    const out = new Set<number>();
    windowChunks(() => 0, -500, 86_400_000, 600, out);
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("leave a clip with no frames alone", () => {
    const out = new Set<number>();
    windowChunks(() => 0, 0, 1000, 0, out);
    expect(out.size).toBe(0);
  });
});
