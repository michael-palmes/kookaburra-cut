import { describe, expect, it } from "vitest";
import { COMPARE_PRESETS } from "./comparePresets";
import { MIN_KEY_GAP_MS } from "./keyedTrack";
import { compareSpecOf, compareValueAt } from "./sceneCompare";
import type { SceneDoc } from "./sceneDocSchema";

const DURATION = 3000;

const specFor = (track: ReturnType<(typeof COMPARE_PRESETS)[number]["build"]>) =>
  compareSpecOf({ version: 1, compare: { track } } as SceneDoc);

describe("compare presets (structure pin)", () => {
  it("every preset builds a legal track: ascending keys inside the scene, clamped values, segments referencing real keys", () => {
    for (const preset of COMPARE_PRESETS) {
      const track = preset.build(DURATION);
      expect(track.keys.length).toBeGreaterThan(0);
      const ids = new Set(track.keys.map((k) => k.id));
      expect(ids.size).toBe(track.keys.length);
      for (let i = 1; i < track.keys.length; i++) {
        expect(track.keys[i].tMs - track.keys[i - 1].tMs).toBeGreaterThanOrEqual(MIN_KEY_GAP_MS);
      }
      for (const k of track.keys) {
        expect(k.tMs).toBeGreaterThanOrEqual(0);
        expect(k.tMs).toBeLessThanOrEqual(DURATION);
        expect(Number.isInteger(k.tMs)).toBe(true);
        expect(k.pose.value).toBeGreaterThanOrEqual(0);
        expect(k.pose.value).toBeLessThanOrEqual(1);
      }
      for (const s of track.segments) {
        expect(ids.has(s.from)).toBe(true);
        expect(ids.has(s.to)).toBe(true);
      }
    }
  });

  it("reveal travels all-before to all-after; hold sits at half throughout", () => {
    const reveal = specFor(
      COMPARE_PRESETS.find((p) => p.id === "reveal")?.build(DURATION) ?? { keys: [], segments: [] },
    );
    expect(reveal).not.toBeNull();
    if (!reveal) return;
    expect(compareValueAt(reveal, 0)).toBe(1);
    expect(compareValueAt(reveal, DURATION)).toBe(0);
    const hold = specFor(
      COMPARE_PRESETS.find((p) => p.id === "hold")?.build(DURATION) ?? { keys: [], segments: [] },
    );
    if (!hold) return;
    expect(compareValueAt(hold, 0)).toBe(0.5);
    expect(compareValueAt(hold, DURATION)).toBe(0.5);
  });

  it("peek returns to all-before mid-scene before committing", () => {
    const peek = specFor(
      COMPARE_PRESETS.find((p) => p.id === "peek")?.build(DURATION) ?? { keys: [], segments: [] },
    );
    if (!peek) return;
    expect(compareValueAt(peek, DURATION * 0.4)).toBe(1);
    expect(compareValueAt(peek, DURATION * 0.22)).toBeCloseTo(0.7, 10);
    expect(compareValueAt(peek, DURATION)).toBe(0);
  });
});
