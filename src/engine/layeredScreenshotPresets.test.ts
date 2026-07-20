import { describe, expect, it } from "vitest";
import {
  deriveZoomToItemPose,
  expandToIsometric,
  flattenToFrontOn,
  ISO_AZIMUTH_DEG,
  ISO_ELEVATION_DEG,
  slowDrift,
  zoomToItem,
} from "./layeredScreenshotPresets";
import type { LayeredScreenshotPose } from "./sceneDocSchema";
import {
  defaultLayeredScreenshotPose,
  normalizeLayeredScreenshot,
  sampleLoopedLayeredScreenshotTrack,
  sampleLayeredScreenshotTrack,
} from "./sceneLayeredScreenshot";

const pose = (over: Partial<LayeredScreenshotPose> = {}): LayeredScreenshotPose => ({
  ...defaultLayeredScreenshotPose(),
  ...over,
});

describe("preset scaffolds", () => {
  it("expand lands spread 1 at the shared iso angles, keeping zoom and pan", () => {
    const t = expandToIsometric(pose({ zoom: 1.3, pan: [0.2, -0.1] }), 5000);
    expect(t.keys.map((k) => k.tMs)).toEqual([0, 1200]);
    expect(t.segments).toEqual([{ from: "k1", to: "k2", ease: "inOutCubic" }]);
    expect(t.keys[1].pose).toEqual({
      spread: 1,
      azimuthDeg: ISO_AZIMUTH_DEG,
      elevationDeg: ISO_ELEVATION_DEG,
      zoom: 1.3,
      pan: [0.2, -0.1],
    });
  });

  it("flatten is the inverse and both clamp inside short scenes", () => {
    const t = flattenToFrontOn(pose({ spread: 1, azimuthDeg: 30 }), 800);
    expect(t.keys[1].tMs).toBe(800);
    expect(t.keys[1].pose).toMatchObject({ spread: 0, azimuthDeg: 0, elevationDeg: 0 });
  });

  it("drift is a closed loop with a jump present-loop", () => {
    const from = pose({ azimuthDeg: 10 });
    const t = slowDrift(from, 60000);
    expect(t.keys).toHaveLength(4);
    expect(t.keys[3].tMs).toBe(7000);
    expect(t.keys[3].pose).toEqual(t.keys[0].pose);
    expect(t.presentLoop).toEqual({ mode: "jump" });
  });
});

describe("deriveZoomToItemPose", () => {
  const rect = { id: "a", x: 1, y: -0.5, width: 2, height: 3 };

  it("fills 70% of the tighter safe axis, front-on, and centres the item", () => {
    const p = deriveZoomToItemPose(pose({ spread: 0.4 }), rect, 1, 8, 4.2);
    // Height is the tighter axis: zoom = 0.7 * 4.2/3 = 0.98.
    expect(p.zoom).toBeCloseTo(0.98, 12);
    expect(p.azimuthDeg).toBe(0);
    expect(p.spread).toBe(0.4);
    expect(p.pan[0]).toBeCloseTo(-rect.x * p.zoom, 12);
    expect(p.pan[1]).toBeCloseTo(-rect.y * p.zoom, 12);
  });

  it("degenerate rects keep the base zoom", () => {
    const p = deriveZoomToItemPose(pose({ zoom: 2 }), { ...rect, width: 0 }, 1, 8, 4.2);
    expect(p.zoom).toBe(2);
  });

  it("zoomToItem scaffolds the two-key push-in", () => {
    const t = zoomToItem(pose(), rect, 1, 8, 4.2, 5000);
    expect(t.keys[1].tMs).toBe(1000);
    expect(t.keys[1].pose.zoom).toBeCloseTo(0.98, 12);
  });
});

describe("sampleLoopedLayeredScreenshotTrack", () => {
  const tracked = (presentLoop: { mode: "smooth" | "jump"; blendMs?: number }) => {
    const n = normalizeLayeredScreenshot(
      {
        layers: [],
        pose: pose(),
        animation: {
          keys: [
            { id: "k1", tMs: 0, pose: pose({ azimuthDeg: 0 }) },
            { id: "k2", tMs: 1000, pose: pose({ azimuthDeg: 40 }) },
          ],
          segments: [{ from: "k1", to: "k2", ease: "linear" }],
          presentLoop,
        },
      },
      "test",
    );
    if (!n?.track?.presentLoop) throw new Error("track with loop expected");
    return n.track;
  };

  it("matches the plain sample inside the authored span (the play-once contract)", () => {
    const t = tracked({ mode: "jump" });
    expect(sampleLoopedLayeredScreenshotTrack(t, 500, { mode: "jump" })).toEqual(
      sampleLayeredScreenshotTrack(t, 500),
    );
  });

  it("jump wraps the keyed span past the end", () => {
    const t = tracked({ mode: "jump" });
    expect(sampleLoopedLayeredScreenshotTrack(t, 1500, { mode: "jump" }).azimuthDeg).toBeCloseTo(
      20,
    );
  });

  it("smooth blends back to the first key over blendMs, then replays", () => {
    const t = tracked({ mode: "smooth", blendMs: 400 });
    const loop = { mode: "smooth" as const, blendMs: 400 };
    // Halfway through the blend: inOutQuad(0.5) = 0.5 → halfway from 40 back to 0.
    expect(sampleLoopedLayeredScreenshotTrack(t, 1200, loop).azimuthDeg).toBeCloseTo(20);
    // Past the blend, the replay runs the span again.
    expect(sampleLoopedLayeredScreenshotTrack(t, 1900, loop).azimuthDeg).toBeCloseTo(20);
  });

  it("normalizeTrack drops an invalid presentLoop but keeps the track", () => {
    const n = normalizeLayeredScreenshot(
      {
        layers: [],
        pose: pose(),
        animation: {
          keys: [{ id: "k1", tMs: 0, pose: pose() }],
          segments: [],
          presentLoop: { mode: "sideways" } as unknown as { mode: "jump" },
        },
      },
      "test",
    );
    expect(n?.track).not.toBeNull();
    expect(n?.track?.presentLoop).toBeUndefined();
  });
});
