import { DoubleSide, Texture } from "three";
import { describe, expect, it } from "vitest";
import type { SceneDocMediaSpec } from "../../engine/sceneDocSchema";
import { normalizeWindowChrome, RECORDING_INSETS } from "../../engine/sceneVideoWindow";
import type { FormatInfo } from "../types";
import {
  createStageImageShadowMaterials,
  resolveOverlayImageStackOrders,
  resolveOverlayImageTransform,
  resolveStageImageTransform,
  resolveWindowMediaTransform,
  sampleRenderedSceneMediaMotion,
  shouldNeutraliseSceneMediaMotion,
  windowChromeSurface,
  windowGeometry,
} from "./SceneMedia";

const entry = (over: Partial<SceneDocMediaSpec> = {}): SceneDocMediaSpec => ({
  id: "m1",
  kind: "image",
  src: "assets/hero.png",
  host: "stage",
  stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
  overlay: { position: [0, 0], size: 0.25, rotationDeg: 0, shape: "none", layer: "above" },
  ...over,
});

const identity = {
  position: [0, 0, 0] as [number, number, number],
  rotationDeg: [0, 0, 0] as [number, number, number],
  scale: 1,
  opacity: 1,
};

const format = {
  width: 1600,
  height: 900,
  aspect: 16 / 9,
  frame: { width: 8, height: 4.5 },
  safe: { top: 0.2, right: 0.2, bottom: 0.2, left: 0.2 },
} satisfies FormatInfo;

describe("SceneMedia transforms", () => {
  it("neutralises motion only while the editor Media domain owns the gizmos", () => {
    const spinning = entry({ motion: { preset: "turntable" } });
    expect(sampleRenderedSceneMediaMotion(spinning, 2000, false).rotationDeg[1]).toBe(36);
    expect(sampleRenderedSceneMediaMotion(spinning, 2000, true)).toEqual(identity);
    expect(shouldNeutraliseSceneMediaMotion(true, false)).toBe(true);
    expect(shouldNeutraliseSceneMediaMotion(true, true)).toBe(false);
    expect(shouldNeutraliseSceneMediaMotion(false, false)).toBe(false);
  });

  it("samples a video entry through the window family's maths", () => {
    const drifting = entry({ kind: "video", src: "assets/clip.mp4", motion: { preset: "drift" } });
    const sample = sampleRenderedSceneMediaMotion(drifting, 2500, false);
    expect(sample.rotationDeg[1]).toBeCloseTo(4 * Math.sin(Math.PI * 2 * 0.1 * 2.5), 6);
    // `turntable` is the still family's preset; a video leaves it inert rather than faking it.
    expect(
      sampleRenderedSceneMediaMotion(
        entry({ kind: "video", motion: { preset: "turntable" } }),
        2000,
        false,
      ),
    ).toEqual(identity);
    // ...and `drift` is the window family's, inert on a still.
    expect(
      sampleRenderedSceneMediaMotion(entry({ motion: { preset: "drift" } }), 2000, false),
    ).toEqual(identity);
  });

  it("places an Overlay-hosted window at the frame fractions the video window used", () => {
    const windowed = entry({
      kind: "video",
      host: "overlay",
      window: { radius: "macos" },
      overlay: {
        position: [0.5, -0.4],
        size: 0.72,
        rotationDeg: 0,
        shape: "none",
        layer: "below",
      },
    });
    const transform = resolveWindowMediaTransform(
      windowed,
      { ...identity, position: [0.1, 0.2, 0.3], rotationDeg: [10, -20, 0], scale: 0.9 },
      format,
    );
    // The legacy group sat at `offset * frame`, and an overlay position is half-frame relative.
    expect(transform.position).toEqual([0.1 + 2, 0.2 - 0.9, 0.3]);
    expect(transform.rotation[0]).toBeCloseTo((10 * Math.PI) / 180);
    expect(transform.rotation[1]).toBeCloseTo((-20 * Math.PI) / 180);
    expect(transform.scale).toBe(0.9);
    expect(transform.box.width).toBeCloseTo(0.72 * format.frame.width);
    expect(transform.box.height).toBeCloseTo(0.72 * format.frame.height);
  });

  it("places a Stage-hosted window in world units, motion scaling the whole group", () => {
    const windowed = entry({
      kind: "video",
      host: "stage",
      window: { radius: "sharp" },
      stage: { position: [1, -2, 0.5], size: 3, rotationDeg: [0, 15, 0] },
    });
    const transform = resolveWindowMediaTransform(
      windowed,
      { ...identity, position: [0.25, 0, 0], rotationDeg: [0, 5, 0], scale: 1.2 },
      format,
    );
    expect(transform.position).toEqual([1.25, -2, 0.5]);
    expect(transform.rotation[1]).toBeCloseTo((20 * Math.PI) / 180);
    expect(transform.scale).toBe(1.2);
    expect(transform.box).toEqual({ width: 3, height: null });
  });

  it("adds deterministic Stage motion over the authored placement", () => {
    const transform = resolveStageImageTransform(
      { position: [1, -2, 0.5], size: 2, rotationDeg: [10, 20, 30] },
      {
        position: [0.25, 0.5, -0.5],
        rotationDeg: [5, -10, 15],
        scale: 0.75,
        opacity: 0.4,
      },
    );
    expect(transform.position).toEqual([1.25, -1.5, 0]);
    expect(transform.rotation).toEqual([
      (15 * Math.PI) / 180,
      (10 * Math.PI) / 180,
      (45 * Math.PI) / 180,
    ]);
    expect(transform.size).toBe(1.5);
    expect(transform.opacity).toBe(0.4);
  });

  it("maps Overlay placement to the full frame and keeps clockwise roll", () => {
    const transform = resolveOverlayImageTransform(
      {
        position: [0.5, -0.5],
        size: 0.25,
        rotationDeg: 20,
        shape: "none",
        layer: "above",
      },
      { ...identity, position: [0.25, 0.1, 0], rotationDeg: [0, 0, 10], scale: 0.5 },
      format,
      2,
      3,
    );
    expect(transform.position).toEqual([3, -0.9, 0]);
    expect(transform.rotation[2]).toBeCloseTo((-30 * Math.PI) / 180);
    expect(transform.width).toBe(1);
    expect(transform.height).toBe(0.5);
    expect(transform.renderOrder).toBe(1003);
  });

  it("makes circle crops square and routes below-panel images under editorial content", () => {
    const transform = resolveOverlayImageTransform(
      {
        position: [0, 0],
        size: 0.2,
        rotationDeg: 0,
        shape: "circle",
        layer: "below",
      },
      identity,
      format,
      3,
      8,
    );
    expect(transform.height).toBe(transform.width);
    expect(transform.renderOrder).toBe(-992);
  });

  it("uses the source alpha for directional, spot and point-light shadow maps", () => {
    const texture = new Texture();
    const materials = createStageImageShadowMaterials(texture);
    for (const material of [materials.depth, materials.distance]) {
      expect(material.map).toBe(texture);
      expect(material.alphaTest).toBeGreaterThan(0);
      expect(material.side).toBe(DoubleSide);
      material.dispose();
    }
  });

  it("leaves an unrecorded chrome sampling the whole source at the authored radius", () => {
    const chrome = normalizeWindowChrome({ radius: "macos" });
    expect(windowChromeSurface(chrome, { width: 1920, height: 1080 })).toEqual({
      cropAspect: null,
      radiusFraction: chrome.radiusFraction,
      uv: null,
    });
    // Recording mode waits for the source's pixel size before it can crop anything.
    expect(
      windowChromeSurface(normalizeWindowChrome({ radius: "macos", recording: true }), null),
    ).toEqual({ cropAspect: null, radiusFraction: chrome.radiusFraction, uv: null });
  });

  it("crops a recording to the window itself, in source pixels, and follows its true radius", () => {
    const surface = windowChromeSurface(
      normalizeWindowChrome({ radius: "macos", recording: true }),
      {
        width: 2000,
        height: 1400,
      },
    );
    if (!surface.uv) throw new Error("recording mode did not crop");
    expect(surface.cropAspect).toBeCloseTo(
      (2000 - 2 * RECORDING_INSETS.left - 4) /
        (1400 - RECORDING_INSETS.top - RECORDING_INSETS.bottom - 4),
      6,
    );
    expect(surface.uv.scale[0]).toBeCloseTo((2000 - 2 * RECORDING_INSETS.left - 4) / 2000, 6);
    expect(surface.uv.offset[0]).toBeCloseTo((RECORDING_INSETS.left + 2) / 2000, 6);
    // The macOS preset tracks the capture; a hand-set radius stays as authored.
    expect(surface.radiusFraction).not.toBe(
      normalizeWindowChrome({ radius: "macos" }).radiusFraction,
    );
    expect(
      windowChromeSurface(normalizeWindowChrome({ radius: "rounded", recording: true }), {
        width: 2000,
        height: 1400,
      }).radiusFraction,
    ).toBe(normalizeWindowChrome({ radius: "rounded" }).radiusFraction);
  });

  it("contain-fits a clip inside its size box, and leaves the Stage width free", () => {
    const chrome = normalizeWindowChrome({ radius: "macos" });
    const wide = windowGeometry(
      { width: 8, height: 4.5 },
      chrome,
      { width: 1920, height: 1080 },
      null,
    );
    expect(wide.rect).toEqual({ width: 8, height: 4.5 });
    const tall = windowGeometry(
      { width: 8, height: 4.5 },
      chrome,
      { width: 1080, height: 1920 },
      null,
    );
    expect(tall.rect.height).toBeCloseTo(4.5, 6);
    expect(tall.rect.width).toBeCloseTo(4.5 * (1080 / 1920), 6);
    const staged = windowGeometry({ width: 3, height: null }, chrome, null, 2);
    expect(staged.rect).toEqual({ width: 3, height: 1.5 });
  });

  it("places unnumbered images after explicit image and decoration orders", () => {
    const image = (id: string, stackOrder?: number) =>
      entry({
        id,
        host: "overlay",
        overlay: {
          position: [0, 0],
          size: 0.25,
          rotationDeg: 0,
          shape: "none",
          layer: "above",
          ...(stackOrder === undefined ? {} : { stackOrder }),
        },
      });
    expect(resolveOverlayImageStackOrders([image("a"), image("b", 100), image("c")], 8)).toEqual([
      101, 100, 102,
    ]);
  });
});
