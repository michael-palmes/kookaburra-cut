import { describe, expect, it } from "vitest";
import type { DeviceMediaSpec } from "../toolkit/device/Device";
import {
  clipFrameIndex,
  clipPlaneSize,
  clipSourceFrameIndex,
  deviceClipFrameIndex,
  hasPlaybackKeys,
} from "./clipFrame";
import { FPS } from "./format";

describe("clipFrameIndex — pure frame selection (hold first/last)", () => {
  const fps = 60;
  const frameCount = 700;

  it("holds the first frame before the clip starts", () => {
    expect(clipFrameIndex(-500, 0, fps, frameCount)).toBe(0);
    expect(clipFrameIndex(0, 1000, fps, frameCount)).toBe(0); // startMs after now
  });

  it("returns frame 0 exactly at the start", () => {
    expect(clipFrameIndex(1000, 1000, fps, frameCount)).toBe(0);
  });

  it("floors elapsed time × fps to a frame index", () => {
    expect(clipFrameIndex(1000, 0, fps, frameCount)).toBe(60); // 1.0s × 60
    expect(clipFrameIndex(500, 0, fps, frameCount)).toBe(30); // 0.5s × 60
    expect(clipFrameIndex(1016, 0, fps, frameCount)).toBe(60); // 1.016s × 60 = 60.96 → 60
  });

  it("respects startMs offset", () => {
    expect(clipFrameIndex(2000, 1000, fps, frameCount)).toBe(60); // (2000−1000)ms × 60
  });

  it("holds the last frame past the end of the footage", () => {
    expect(clipFrameIndex(1_000_000, 0, fps, frameCount)).toBe(frameCount - 1);
  });

  it("is safe with no frames", () => {
    expect(clipFrameIndex(1234, 0, fps, 0)).toBe(0);
  });
});

describe("clipFrameIndex — loop mode (v12 · M4 video background fills)", () => {
  const fps = 60;
  const frameCount = 90; // a 1.5s clip

  it("wraps past the end of the footage (the export-contract modulo)", () => {
    expect(clipFrameIndex(1500, 0, fps, frameCount, true)).toBe(0); // exactly one loop
    expect(clipFrameIndex(1516, 0, fps, frameCount, true)).toBe(0); // 90.96 → 90 → wraps to 0
    expect(clipFrameIndex(2000, 0, fps, frameCount, true)).toBe(30); // 120 % 90
    expect(clipFrameIndex(4516, 0, fps, frameCount, true)).toBe(0); // three loops in
  });

  it("matches the clamp path inside the first pass", () => {
    for (const ms of [0, 250, 745, 1483]) {
      expect(clipFrameIndex(ms, 0, fps, frameCount, true)).toBe(
        clipFrameIndex(ms, 0, fps, frameCount),
      );
    }
  });

  it("wraps negative time mathematically (never a negative index)", () => {
    expect(clipFrameIndex(-100, 0, fps, frameCount, true)).toBe(84); // −6 → 84
  });

  it("defaults OFF — the frozen hold behaviour is untouched", () => {
    expect(clipFrameIndex(1_000_000, 0, fps, frameCount)).toBe(frameCount - 1);
  });

  it("is safe with no frames", () => {
    expect(clipFrameIndex(1234, 0, fps, 0, true)).toBe(0);
  });
});

describe("deviceClipFrameIndex, the legacy path", () => {
  const fps = 60;
  const frame = 1000 / 60;
  // Every frame instant the clock lands on, plus in-betweens, across a transition lead-in and a long scene.
  const times: number[] = [];
  for (let k = -90; k <= 1300; k++) {
    times.push(k * frame, k * frame + 0.5, k * frame + frame / 2, k * frame - 0.25);
  }
  const offsets = [0, frame, 250, 37 * frame, 1234.5, 2000];
  const starts = [undefined, 0, 17, 400, 600, 2000, -333, -2000, 37 * frame, -11 * frame];
  const counts = [0, 1, 228, 700];

  it("matches the literal clipFrameIndex call for specs without the new keys", () => {
    let checked = 0;
    for (const n of counts) {
      for (const offsetMs of offsets) {
        for (const startMs of starts) {
          const specs: DeviceMediaSpec[] = [
            { src: "assets/clip.mp4", kind: "video", startMs },
            { src: "assets/clip.mp4", kind: "video", startMs, fit: "cover", startOn: "open" },
          ];
          for (const m of specs) {
            for (const t of times) {
              const legacy = clipFrameIndex(t, offsetMs + (m.startMs ?? 0), fps, n);
              if (deviceClipFrameIndex(t, offsetMs, m, fps, n) !== legacy) {
                throw new Error(`diverged at t=${t} offset=${offsetMs} start=${startMs} n=${n}`);
              }
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(800_000);
  });

  it("keeps the legacy operation order when a key is present but neutral", () => {
    const neutral: Partial<DeviceMediaSpec>[] = [{ loop: false }, { speed: 1 }, { inMs: 0 }];
    for (const keys of neutral) {
      for (const offsetMs of offsets) {
        for (const startMs of starts) {
          const m: DeviceMediaSpec = { src: "assets/clip.mp4", kind: "video", startMs, ...keys };
          for (const t of times) {
            const legacy = clipFrameIndex(t, offsetMs + (startMs ?? 0), fps, 700);
            if (deviceClipFrameIndex(t, offsetMs, m, fps, 700) !== legacy) {
              throw new Error(`${JSON.stringify(keys)} diverged at t=${t} offset=${offsetMs}`);
            }
          }
        }
      }
    }
  });
});

describe("deviceClipFrameIndex, playback keys", () => {
  const fps = 60;
  const n = 700;
  const video = (keys: Partial<DeviceMediaSpec>): DeviceMediaSpec => ({
    src: "assets/clip.mp4",
    kind: "video",
    ...keys,
  });
  const at = (localMs: number, keys: Partial<DeviceMediaSpec>, offsetMs = 0, frames = n) =>
    deviceClipFrameIndex(localMs, offsetMs, video(keys), fps, frames);

  it("reads hasPlaybackKeys from key presence alone", () => {
    expect(hasPlaybackKeys(video({ startMs: -2000, fit: "cover", startOn: "open" }))).toBe(false);
    for (const keys of [
      { inMs: 0 },
      { outMs: 1000 },
      { speed: 1 },
      { loop: false },
      { posterMs: 0 },
    ]) {
      expect(hasPlaybackKeys(video(keys)), JSON.stringify(keys)).toBe(true);
    }
  });

  it("starts at inMs and converts whole-frame source times exactly", () => {
    expect(at(0, { inMs: 1000 })).toBe(60);
    expect(at(0, { inMs: 2050 })).toBe(123);
    expect(at(500, { inMs: 1000 })).toBe(90);
    // A trim combines with a delay: the delay holds the first played frame.
    expect(at(400, { inMs: 1000, startMs: 600 })).toBe(60);
    expect(at(1100, { inMs: 1000, startMs: 600 })).toBe(90);
  });

  it("repeats frames below 1× and skips them above, never blending", () => {
    const slow = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => at((k + 0.5) * (1000 / 60), { speed: 0.25 }));
    expect(slow).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(at(1000, { speed: 0.25 })).toBe(15);
    expect(at(1000, { speed: 2 })).toBe(120);
    const fast = [0, 1, 2, 3].map((k) => at((k + 0.5) * (1000 / 60), { speed: 2 }));
    expect(fast).toEqual([1, 3, 5, 7]);
    expect(at(500, { speed: 16 })).toBe(480);
    expect(at(1000, { speed: 16 })).toBe(n - 1);
  });

  it("holds the last played frame past outMs or the clip's end", () => {
    expect(at(999, { inMs: 1000, outMs: 2000 })).toBe(119);
    expect(at(5000, { inMs: 1000, outMs: 2000 })).toBe(119);
    expect(at(60_000, { speed: 2 })).toBe(n - 1);
    // An exclusive out point inside a frame still plays that frame.
    expect(at(5000, { outMs: 1010 })).toBe(60);
  });

  it("wraps within [inMs, outMs) when looping", () => {
    const loop = { inMs: 1000, outMs: 2000, loop: true };
    expect(at(0, loop)).toBe(60);
    expect(at(1000, loop)).toBe(60);
    expect(at(1500, loop)).toBe(90);
    expect(at(2500, loop)).toBe(90);
    // A day-long Present hold keeps looping (a pure function of time).
    expect(at(86_400_000 + 500, loop)).toBe(90);
    // Without an out point the loop takes the clip's end.
    expect(at((n + 30) * (1000 / 60) + 1, { loop: true })).toBe(30);
    expect(at(2000, { loop: true, speed: 2, outMs: 1000 })).toBe(0);
  });

  it("shows the poster before a delay, else the first played frame", () => {
    expect(at(500, { startMs: 1000, posterMs: 3000 })).toBe(180);
    expect(at(1000, { startMs: 1000, posterMs: 3000 })).toBe(0);
    expect(at(500, { startMs: 1000, inMs: 500 })).toBe(30);
    // A transition lead-in sits before playback too.
    expect(at(-200, { posterMs: 1000 })).toBe(60);
    expect(at(0, { posterMs: 1000 })).toBe(0);
  });

  it("shows the poster until a fold opens", () => {
    const openedAtMs = 1200;
    const spec = { startOn: "open" as const, posterMs: 2500, inMs: 500 };
    expect(at(600, spec, openedAtMs)).toBe(150);
    expect(at(1200, spec, openedAtMs)).toBe(30);
    expect(at(1700, spec, openedAtMs)).toBe(60);
    // The delay then counts from the opening.
    expect(at(1700, { ...spec, startMs: 1000 }, openedAtMs)).toBe(150);
  });

  it("plays a negative startMs as scene-clock pre-roll at speed", () => {
    expect(at(0, { startMs: -1000, speed: 2 })).toBe(120);
    expect(at(0, { startMs: -1000, outMs: 1000 })).toBe(59);
  });

  it("clamps trim and poster times past the clip's end", () => {
    expect(at(0, { inMs: 60_000 })).toBe(n - 1);
    expect(at(5000, { inMs: 60_000, loop: true })).toBe(n - 1);
    expect(at(60_000, { outMs: 60_000 })).toBe(n - 1);
    expect(at(60_000, { outMs: 60_000, loop: true })).toBe(3600 % n);
    expect(at(0, { startMs: 500, posterMs: 60_000 })).toBe(n - 1);
    expect(at(0, { inMs: 1000 }, 0, 0)).toBe(0);
  });

  it("degrades values the parser would have dropped instead of returning a bad index", () => {
    // TSX scenes hand Device a spec directly, skipping the sidecar parser.
    for (const speed of [0, -1, Number.NaN, 20]) {
      expect(at(1000, { speed }), String(speed)).toBe(60);
    }
    expect(at(1000, { inMs: Number.NaN })).toBe(60);
    expect(at(1000, { inMs: 2000, outMs: 1000 })).toBe(120);
  });
});

describe("clipPlaneSize — fit math", () => {
  const frame = { width: 16, height: 9 }; // 16:9-ish frame aspect ≈ 1.778

  it("returns zero until the clip geometry is known", () => {
    expect(clipPlaneSize("contain", frame, { width: 0, height: 0 })).toEqual({
      width: 0,
      height: 0,
    });
  });

  it("contain fits a square clip within the frame height", () => {
    expect(clipPlaneSize("contain", frame, { width: 100, height: 100 })).toEqual({
      width: 9,
      height: 9,
    });
  });

  it("cover fills the frame width with a square clip (overflow height)", () => {
    expect(clipPlaneSize("cover", frame, { width: 100, height: 100 })).toEqual({
      width: 16,
      height: 16,
    });
  });

  it("contain letterboxes a clip wider than the frame", () => {
    expect(clipPlaneSize("contain", frame, { width: 200, height: 50 })).toEqual({
      width: 16,
      height: 4,
    });
  });

  it("cover fills the frame height with a clip wider than the frame", () => {
    expect(clipPlaneSize("cover", frame, { width: 200, height: 50 })).toEqual({
      width: 36,
      height: 9,
    });
  });
});

describe("clipSourceFrameIndex, VideoClip inMs", () => {
  const n = 5000;

  it("holds inMs before startMs, then plays from it", () => {
    expect(clipSourceFrameIndex(0, 500, 2000, 60, n)).toBe(120);
    expect(clipSourceFrameIndex(500, 500, 2000, 60, n)).toBe(120);
    expect(clipSourceFrameIndex(1500, 500, 2000, 60, n)).toBe(180);
  });

  it("holds the last frame past the end and degrades a bad inMs to the start", () => {
    expect(clipSourceFrameIndex(1e7, 0, 0, 60, 90)).toBe(89);
    expect(clipSourceFrameIndex(1000, 0, Number.NaN, 60, n)).toBe(60);
    // A negative in-point keeps the source arithmetic, so a hand-off with sourceMs below the cut still lines up.
    expect(clipSourceFrameIndex(0, 0, -400, 60, n)).toBe(0);
    expect(clipSourceFrameIndex(1000, 0, -400, 60, n)).toBe(36);
    expect(clipSourceFrameIndex(1000, 0, 0, 60, 0)).toBe(0);
  });

  it("shows every source frame exactly once on the export clock, where the legacy floor repeats", () => {
    let legacySteps = 0;
    for (const sceneStartMs of [0, 1875, 2000, 3750, 4100, 15000]) {
      for (const [startMs, inMs] of [
        [0, 0],
        [0, 4000],
        [250, 1250],
        [700, 0],
      ]) {
        const first = Math.ceil(((sceneStartMs + startMs) * FPS) / 1000) + 1;
        let previous = clipSourceFrameIndex(
          exportMs(first - 1) - sceneStartMs,
          startMs,
          inMs,
          FPS,
          n,
        );
        for (let frame = first; frame < first + 600; frame++) {
          const local = exportMs(frame) - sceneStartMs;
          const index = clipSourceFrameIndex(local, startMs, inMs, FPS, n);
          expect(index - previous).toBe(1);
          previous = index;
          const legacy = deviceClipFrameIndex(local, 0, video({ startMs, inMs }), FPS, n);
          const legacyBefore = deviceClipFrameIndex(
            local - 1000 / FPS,
            0,
            video({ startMs, inMs }),
            FPS,
            n,
          );
          if (legacy - legacyBefore !== 1) legacySteps++;
        }
      }
    }
    expect(legacySteps).toBeGreaterThan(0);
  });
});

describe("screen portal hand-off on the export clock", () => {
  const n = 100_000;
  // Scene starts on and off the frame grid (128 BPM bars are 112.5 frames), straight cuts.
  const sceneStarts = Array.from({ length: 160 }, (_, i) => i * 125);
  const durations = [1875, 2000, 2343.75, 3750, 1500, 2050];
  const sources = [4000, 4050, 6000, 7500, 10_000];

  /** Scene B starts at the end of scene A: the last export frame inside A and the first inside B. */
  function cut(sceneStartMs: number, durationMs: number) {
    const cutMs = sceneStartMs + durationMs;
    const firstB = Math.ceil((cutMs * FPS) / 1000 - 1e-9);
    return { cutMs, lastA: exportMs(firstB - 1), firstB: exportMs(firstB) };
  }

  it("pull-out: the screen picks up on the very next frame after the full-bleed clip", () => {
    for (const startA of sceneStarts) {
      for (const durationMs of durations) {
        for (const sourceMs of sources) {
          const { cutMs, lastA, firstB } = cut(startA, durationMs);
          const clip = clipSourceFrameIndex(lastA - startA, 0, sourceMs - durationMs, FPS, n);
          const screen = deviceClipFrameIndex(
            firstB - cutMs,
            0,
            video({ startMs: 0, inMs: sourceMs }),
            FPS,
            n,
          );
          expect(screen - clip).toBe(1);
        }
      }
    }
  });

  it("push-through: the full-bleed clip never repeats the screen's last frame and skips at most one", () => {
    for (const startA of sceneStarts) {
      for (const durationMs of [2000, 3750, 1500, 2050]) {
        for (const sourceMs of sources) {
          const { cutMs, lastA, firstB } = cut(startA, durationMs);
          const screen = deviceClipFrameIndex(
            lastA - startA,
            0,
            video({ startMs: 0, inMs: sourceMs - durationMs }),
            FPS,
            n,
          );
          const clip = clipSourceFrameIndex(firstB - cutMs, 0, sourceMs, FPS, n);
          expect(clip).toBe((sourceMs * FPS) / 1000);
          expect([1, 2]).toContain(clip - screen);
        }
      }
    }
  });
});

/** The export loop's clock: `tMs = frame * 1000 / FPS`. */
function exportMs(frame: number): number {
  return (frame * 1000) / FPS;
}

function video(keys: Partial<DeviceMediaSpec>): DeviceMediaSpec {
  return { src: "assets/clip.mp4", kind: "video", ...keys };
}
