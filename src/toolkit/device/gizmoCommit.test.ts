import { describe, expect, it } from "vitest";
import type { V3 } from "../types";
import { type DeviceCommitInput, type DevicePose, deviceGizmoCommit } from "./gizmoCommit";

const pose = (position: V3, rotationDeg: V3 = [0, 0, 0], scale = 1): DevicePose => ({
  position,
  rotationDeg,
  scale,
});

const commit = (input: Partial<DeviceCommitInput>) =>
  deviceGizmoCommit({
    deviceId: "d1",
    sceneIndex: 2,
    dragged: pose([0, -0.3, 0]),
    rendered: pose([0, -0.3, 0]),
    authored: {},
    ...input,
  });

describe("deviceGizmoCommit, placement branch", () => {
  it("writes the dragged pose verbatim when nothing post-processes the placement", () => {
    const result = commit({
      dragged: pose([1.2345, 0.5, -0.75], [0, 32.44, 0], 1.4567),
      rendered: pose([0, -0.3, 0]),
      authored: { position: [0, -0.3, 0] },
    });
    expect(result).toEqual({
      sceneIndex: 2,
      deviceId: "d1",
      kind: "placement",
      placement: { position: [1.235, 0.5, -0.75], rotationDeg: [0, 32.4, 0], scale: 1.457 },
    });
  });

  it("undoes the portrait scale factor so re-rendering reproduces the dragged size", () => {
    const result = commit({
      dragged: pose([0, -0.3, 0], [0, 0, 0], 1),
      rendered: pose([0, -0.3, 0], [0, 0, 0], 0.8),
      authored: { scale: 1 },
    });
    expect(result.kind === "placement" && result.placement.scale).toBe(1.25);
  });

  it("lands only the difference when a consumer offsets the rendered position", () => {
    const result = commit({
      dragged: pose([1.5, -0.3, 0]),
      rendered: pose([1, -0.3, 0]),
      authored: { position: [0.2, -0.3, 0] },
    });
    expect(result.kind === "placement" && result.placement.position).toEqual([0.7, -0.3, 0]);
  });

  it("leaves a grounded device's authored y alone when the drag never moved it", () => {
    const result = commit({
      dragged: pose([1.5, -0.2, 0]),
      rendered: pose([1, -0.2, 0]),
      authored: { position: [1, -0.3, 0] },
    });
    expect(result.kind === "placement" && result.placement.position).toEqual([1.5, -0.3, 0]);
  });

  it("falls back to what the render itself defaults to for an unauthored placement", () => {
    const result = commit({
      dragged: pose([0.5, 0.1, 0.2], [4, 0, 0], 2),
      rendered: pose([0, 0, 0], [0, 0, 0], 1),
      authored: {},
    });
    expect(result).toMatchObject({
      kind: "placement",
      placement: { position: [0.5, 0.1, 0.2], rotationDeg: [4, 0, 0], scale: 2 },
    });
  });

  it("leaves an unauthored position alone on a rotation-only drag", () => {
    const result = commit({
      dragged: pose([0, 0, 0], [0, 24, 0]),
      rendered: pose([0, 0, 0]),
      authored: { rotationDeg: [0, 0, 0] },
    });
    expect(result.kind === "placement" && result.placement.position).toEqual([0, 0, 0]);
  });
});

describe("deviceGizmoCommit, delta branch", () => {
  const laid = pose([1, -0.3, 0.5], [0, -14, 0], 0.85);

  it("adds offsets and rotations onto the existing delta and multiplies the scale", () => {
    const result = commit({
      dragged: pose([1.25, -0.1, 0.5], [0, -9, 0], 0.935),
      rendered: laid,
      delta: { offset: [0.1, 0, 0], rotationDeg: [0, 2, 0], scale: 1.1 },
    });
    expect(result).toEqual({
      sceneIndex: 2,
      deviceId: "d1",
      kind: "delta",
      delta: { offset: [0.35, 0.2, 0], rotationDeg: [0, 7, 0], scale: 1.21 },
    });
  });

  it("starts a device with no delta entry from zero", () => {
    const result = commit({
      dragged: pose([1.5, -0.3, 0.5], [0, -14, 0], 0.85),
      rendered: laid,
      delta: {},
    });
    expect(result.kind === "delta" && result.delta).toEqual({
      offset: [0.5, 0, 0],
      rotationDeg: [0, 0, 0],
      scale: 1,
    });
  });

  it("returns the layout's own values when the drag lands back on the preset pose", () => {
    // The resolved pose already carries the delta, so dragging off it by minus the delta clears it.
    const result = commit({
      dragged: pose([0.6, -0.5, 0.5], [0, -19, 0], 0.68),
      rendered: laid,
      delta: { offset: [0.4, 0.2, 0], rotationDeg: [0, 5, 0], scale: 1.25 },
    });
    expect(result.kind === "delta" && result.delta).toEqual({
      offset: [0, 0, 0],
      rotationDeg: [0, 0, 0],
      scale: 1,
    });
  });
});

describe("deviceGizmoCommit scale guards", () => {
  it("treats a degenerate rendered scale as no change", () => {
    const result = commit({
      dragged: pose([0, -0.3, 0], [0, 0, 0], 3),
      rendered: pose([0, -0.3, 0], [0, 0, 0], 0),
      authored: { scale: 1.4 },
    });
    expect(result.kind === "placement" && result.placement.scale).toBe(1.4);
  });

  it("clamps a collapsed drag to the minimum scale", () => {
    const result = commit({
      dragged: pose([0, -0.3, 0], [0, 0, 0], 0.0001),
      rendered: pose([0, -0.3, 0], [0, 0, 0], 1),
      authored: { scale: 1 },
    });
    expect(result.kind === "placement" && result.placement.scale).toBe(0.01);
  });
});
