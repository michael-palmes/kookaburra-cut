import { describe, expect, it } from "vitest";
import { baseCameraPose } from "./cameraTrack";
import { computeFormat, FORMATS, frameAtDepth } from "./format";
import { frameOnPlane, frustumOnPlane } from "./frustum";

const wide = computeFormat(FORMATS["16:9"]);
const tall = computeFormat(FORMATS["9:16"]);

describe("frustumOnPlane", () => {
  it("hits the content plane at the format frame's corners under the base camera", () => {
    const hits = frustumOnPlane(baseCameraPose(), wide.aspect, 0);
    expect(hits).toHaveLength(4);
    for (const hit of hits) {
      expect(hit).not.toBeNull();
      expect(Math.abs(hit?.[0] ?? 0)).toBeCloseTo(wide.frame.width / 2, 9);
      expect(Math.abs(hit?.[1] ?? 0)).toBeCloseTo(wide.frame.height / 2, 9);
    }
  });

  it("misses a plane at or behind the camera", () => {
    expect(frustumOnPlane(baseCameraPose(), wide.aspect, 6).every((hit) => hit === null)).toBe(
      true,
    );
    expect(frameOnPlane(baseCameraPose(), wide.aspect, 6)).toBeNull();
  });

  it("follows a moved camera", () => {
    const pose = { ...baseCameraPose(), position: [1, 0.5, 5] as [number, number, number] };
    pose.lookAt = [1, 0.5, 0];
    const frame = frameOnPlane(pose, wide.aspect, 0);
    expect(frame?.center[0]).toBeCloseTo(1, 9);
    expect(frame?.center[1]).toBeCloseTo(0.5, 9);
    expect(frame?.width).toBeCloseTo(wide.frame.width, 9);
  });
});

describe("frameAtDepth", () => {
  it("is exactly the format frame at the content plane", () => {
    expect(frameAtDepth(wide, 0)).toEqual(wide.frame);
    expect(frameAtDepth(tall, 0)).toEqual(tall.frame);
  });

  it("grows with distance from the camera", () => {
    // The camera sits at z = 5, so z = -5 is twice as far as the content plane.
    const far = frameAtDepth(wide, -5);
    expect(far.width).toBeCloseTo(wide.frame.width * 2, 9);
    expect(far.height).toBeCloseTo(wide.frame.height * 2, 9);
    expect(frameAtDepth(tall, 2.5).height).toBeCloseTo(tall.frame.height / 2, 9);
  });

  it("is empty at or behind the camera", () => {
    expect(frameAtDepth(wide, 5)).toEqual({ width: 0, height: 0 });
  });
});
