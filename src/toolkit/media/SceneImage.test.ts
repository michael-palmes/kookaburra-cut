import { DoubleSide, Texture } from "three";
import { describe, expect, it } from "vitest";
import type { FormatInfo } from "../types";
import {
  createStageImageShadowMaterials,
  resolveOverlayImageStackOrders,
  resolveOverlayImageTransform,
  resolveStageImageTransform,
  sampleRenderedSceneImageMotion,
  shouldNeutraliseSceneImageMotion,
} from "./SceneImage";

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

describe("SceneImage transforms", () => {
  it("neutralises motion only while the editor Image domain owns the gizmos", () => {
    expect(
      sampleRenderedSceneImageMotion({ preset: "turntable" }, "stage", 2000, false).rotationDeg[1],
    ).toBe(36);
    expect(sampleRenderedSceneImageMotion({ preset: "turntable" }, "stage", 2000, true)).toEqual(
      identity,
    );
    expect(shouldNeutraliseSceneImageMotion(true, false)).toBe(true);
    expect(shouldNeutraliseSceneImageMotion(true, true)).toBe(false);
    expect(shouldNeutraliseSceneImageMotion(false, false)).toBe(false);
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

  it("places unnumbered images after explicit image and decoration orders", () => {
    const image = (id: string, stackOrder?: number) => ({
      id,
      src: `assets/${id}.png`,
      host: "overlay" as const,
      stage: {
        position: [0, 0, 0] as [number, number, number],
        size: 1,
        rotationDeg: [0, 0, 0] as [number, number, number],
      },
      overlay: {
        position: [0, 0] as [number, number],
        size: 0.25,
        rotationDeg: 0,
        shape: "none" as const,
        layer: "above" as const,
        ...(stackOrder === undefined ? {} : { stackOrder }),
      },
    });
    expect(resolveOverlayImageStackOrders([image("a"), image("b", 100), image("c")], 8)).toEqual([
      101, 100, 102,
    ]);
  });
});
