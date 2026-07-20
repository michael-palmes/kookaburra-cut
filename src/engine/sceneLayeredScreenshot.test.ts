import { describe, expect, it, vi } from "vitest";
import type {
  LayeredScreenshotItem,
  LayeredScreenshotPose,
  SceneDocLayeredScreenshot,
} from "./sceneDocSchema";
import {
  defaultLayeredScreenshotPose,
  normalizeLayeredScreenshot,
  resolveLayeredScreenshotPose,
  sampleLayeredScreenshotTrack,
} from "./sceneLayeredScreenshot";

const screen = (
  id: string,
  attach: LayeredScreenshotItem["attach"],
  over: Partial<LayeredScreenshotItem> = {},
): LayeredScreenshotItem => ({
  id,
  kind: "screen",
  src: `assets/${id}.png`,
  media: "image",
  attach,
  ...over,
});

const pose = (over: Partial<LayeredScreenshotPose> = {}): LayeredScreenshotPose => ({
  ...defaultLayeredScreenshotPose(),
  ...over,
});

const doc = (over: Partial<SceneDocLayeredScreenshot> = {}): SceneDocLayeredScreenshot => ({
  layers: [
    {
      id: "l1",
      visible: true,
      z: 0,
      items: [screen("centre", null), screen("r1", { to: "centre", side: "right" })],
    },
  ],
  pose: pose(),
  ...over,
});

describe("normalizeLayeredScreenshot", () => {
  it("passes a well-formed composition through", () => {
    const n = normalizeLayeredScreenshot(doc(), "test");
    expect(n?.layers).toHaveLength(1);
    expect(n?.layers[0].items.map((i) => i.id)).toEqual(["centre", "r1"]);
    expect(n?.track).toBeNull();
  });

  it("returns null only when the block is absent", () => {
    expect(normalizeLayeredScreenshot(undefined, "test")).toBeNull();
    const empty = normalizeLayeredScreenshot(doc({ layers: [] }), "test");
    expect(empty?.layers).toEqual([]);
  });

  it("empties a layer with no root and drops extra roots' orphans", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noRoot = normalizeLayeredScreenshot(
      doc({
        layers: [
          { id: "l1", visible: true, z: 0, items: [screen("a", { to: "b", side: "left" })] },
        ],
      }),
      "test",
    );
    expect(noRoot?.layers[0].items).toEqual([]);
    const twoRoots = normalizeLayeredScreenshot(
      doc({
        layers: [
          {
            id: "l1",
            visible: true,
            z: 0,
            items: [
              screen("first", null),
              screen("second", null),
              screen("onSecond", { to: "second", side: "top" }),
            ],
          },
        ],
      }),
      "test",
    );
    expect(twoRoots?.layers[0].items.map((i) => i.id)).toEqual(["first"]);
    warn.mockRestore();
  });

  it("drops unresolvable and cyclic attach chains", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const n = normalizeLayeredScreenshot(
      doc({
        layers: [
          {
            id: "l1",
            visible: true,
            z: 0,
            items: [
              screen("centre", null),
              screen("ok", { to: "centre", side: "right" }),
              screen("dangling", { to: "ghost", side: "left" }),
              screen("cycleA", { to: "cycleB", side: "top" }),
              screen("cycleB", { to: "cycleA", side: "bottom" }),
            ],
          },
        ],
      }),
      "test",
    );
    expect(n?.layers[0].items.map((i) => i.id)).toEqual(["centre", "ok"]);
    warn.mockRestore();
  });

  it("keeps the first of duplicate item ids and defaults layer visibility on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const n = normalizeLayeredScreenshot(
      doc({
        layers: [
          {
            id: "l1",
            visible: undefined as unknown as boolean,
            z: Number.NaN,
            items: [screen("centre", null), screen("centre", { to: "centre", side: "left" })],
          },
        ],
      }),
      "test",
    );
    expect(n?.layers[0].items).toHaveLength(1);
    expect(n?.layers[0].visible).toBe(true);
    expect(n?.layers[0].z).toBe(0);
    warn.mockRestore();
  });

  it("clamps spread and zoom, leaves angles untouched", () => {
    const n = normalizeLayeredScreenshot(
      doc({ pose: pose({ spread: 4, zoom: 0, azimuthDeg: -400 }) }),
      "test",
    );
    expect(n?.pose.spread).toBe(1);
    expect(n?.pose.zoom).toBe(0.05);
    expect(n?.pose.azimuthDeg).toBe(-400);
  });

  it("normalizes the animation track with camera semantics", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const n = normalizeLayeredScreenshot(
      doc({
        animation: {
          keys: [
            { id: "k2", tMs: 1000, pose: pose({ azimuthDeg: 30 }) },
            { id: "k1", tMs: -50, pose: pose() },
            { id: "bad", tMs: Number.NaN, pose: pose() },
          ],
          segments: [
            { from: "k1", to: "k2", ease: "linear" },
            { from: "k2", to: "k1", ease: "linear" },
          ],
        },
      }),
      "test",
    );
    expect(n?.track?.keys.map((k) => k.tMs)).toEqual([0, 1000]);
    expect(n?.track?.segments).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("sampleLayeredScreenshotTrack + resolveLayeredScreenshotPose", () => {
  const tracked = () =>
    normalizeLayeredScreenshot(
      doc({
        pose: pose({ azimuthDeg: -5 }),
        animation: {
          keys: [
            { id: "k1", tMs: 0, pose: pose({ spread: 0, azimuthDeg: 0 }) },
            { id: "k2", tMs: 1000, pose: pose({ spread: 1, azimuthDeg: 30 }) },
          ],
          segments: [{ from: "k1", to: "k2", ease: "linear" }],
        },
      }),
      "test",
    );

  it("interpolates inside a segment and holds outside", () => {
    const n = tracked();
    if (!n?.track) throw new Error("track expected");
    expect(sampleLayeredScreenshotTrack(n.track, 500).azimuthDeg).toBeCloseTo(15);
    expect(sampleLayeredScreenshotTrack(n.track, 500).spread).toBeCloseTo(0.5);
    expect(sampleLayeredScreenshotTrack(n.track, 5000).azimuthDeg).toBeCloseTo(30);
    expect(sampleLayeredScreenshotTrack(n.track, -10).azimuthDeg).toBeCloseTo(0);
  });

  it("only animates when the scene's animated track is the layered screenshot", () => {
    const n = tracked();
    if (!n) throw new Error("composition expected");
    expect(resolveLayeredScreenshotPose(n, "layeredScreenshot", 500).azimuthDeg).toBeCloseTo(15);
    expect(resolveLayeredScreenshotPose(n, undefined, 500).azimuthDeg).toBe(-5);
    expect(resolveLayeredScreenshotPose(n, "camera", 500).azimuthDeg).toBe(-5);
  });
});
