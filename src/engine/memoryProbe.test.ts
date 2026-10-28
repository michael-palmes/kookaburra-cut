import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRecorder } from "./memoryProbe";
import type { SceneSlot } from "./sceneTimeline";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./clips", () => ({
  clipCacheCensus: () => ({ clips: 2, textures: 4, bytes: 24e6 }),
  setClipCacheCapacity: vi.fn(),
}));
vi.mock("./exportBridge", () => ({ canvasHandle: { current: null } }));

const slots: SceneSlot[] = [
  { index: 0, id: "intro", startMs: 0, endMs: 30_000, durationMs: 30_000 },
  { index: 1, id: "fold-open", startMs: 30_000, endMs: 60_000, durationMs: 30_000 },
];

/** Plays a 60 s film at `rate(second)` fps, one progress report per frame, with the editor at `editor(second)` bytes. */
async function run(rate: (s: number) => number, editor: (s: number) => number) {
  let clock = 0;
  let second = 0;
  vi.mocked(invoke).mockImplementation(async () => ({
    editor: editor(second),
    gpu: 1e9,
    render: null,
    app: 1e8,
    ffmpeg: 5e7,
  }));
  const rec = new MemoryRecorder(slots, 30, () => clock);
  let frame = 0;
  for (second = 0; second < 60; second++) {
    const n = rate(second);
    for (let i = 0; i < n; i++) {
      frame++;
      clock = second * 1000 + (i * 1000) / n;
      rec.onProgress({ frame, total: 10_000, stage: "render" });
    }
  }
  return rec.summary();
}

beforeEach(() => vi.mocked(invoke).mockReset());

describe("MemoryRecorder", () => {
  it("holds when the rate and the editor stay put", async () => {
    const s = await run(
      () => 8,
      () => 2e9,
    );
    expect(s.holds).toBe(true);
    expect(s.fps).toEqual([8, 8, 8]);
    expect(s.editorMb).toEqual({ first: 2000, peak: 2000, last: 2000 });
    expect(s.points[0]).toMatchObject({ scene: "intro", clipTextures: 4, clipMb: 24 });
  });

  it("fails a run that slows down and grows, and says why", async () => {
    const s = await run(
      (sec) => (sec < 20 ? 8 : sec < 40 ? 3 : 1),
      (sec) => 2e9 + sec * 30e6,
    );
    expect(s.holds).toBe(false);
    expect(s.fps[0]).toBeGreaterThan(7);
    expect(s.fps[2]).toBeLessThan(1.5);
    expect(s.failures[0]).toMatch(/^render slowed from 8/);
    expect(s.failures[1]).toMatch(/^the editor grew \d+ MB and kept it/);
    expect(s.editorGrowthMb).toBeGreaterThan(1000);
  });

  it("ignores a spike that comes and goes, such as a transition's MSAA pair", async () => {
    const s = await run(
      () => 8,
      (sec) => (sec >= 28 && sec < 32 ? 2.9e9 : 2e9),
    );
    expect(s.holds).toBe(true);
    expect(s.editorMb.peak).toBe(2900);
    expect(s.editorGrowthMb).toBe(0);
  });
});
