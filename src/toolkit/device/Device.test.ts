import { describe, expect, it, vi } from "vitest";

vi.mock("@react-three/drei", () => {
  const useGLTF = Object.assign(() => ({ scene: null }), { preload: vi.fn() });
  return {
    Environment: () => null,
    Lightformer: () => null,
    useGLTF,
    useTexture: vi.fn(),
  };
});

import {
  deviceAcknowledgementDisposition,
  deviceMotionForRender,
  shouldNeutraliseDeviceMotion,
} from "./Device";

describe("Device editor motion", () => {
  it("neutralises motion on every editor side while Devices owns the gizmos", () => {
    const motion = { preset: "float" as const, amplitude: 0.2, hz: 0.6 };

    expect(deviceMotionForRender(motion, true, false)).toEqual({ preset: "none" });
    expect(deviceMotionForRender(motion, false, false)).toBe(motion);
    expect(deviceMotionForRender(motion, true, true)).toBe(motion);
    expect(shouldNeutraliseDeviceMotion(true, false)).toBe(true);
    expect(shouldNeutraliseDeviceMotion(true, true)).toBe(false);
  });
});

describe("Device gizmo acknowledgement", () => {
  const failed = { sceneIndex: 3, deviceId: "d2", succeeded: false };

  it("rolls back only the initiating editable preview after a failed write", () => {
    const requested = new Set([7]);
    expect(deviceAcknowledgementDisposition(failed, 7, 3, "d2", true, requested, 7)).toBe(
      "clear-preview",
    );
    expect(deviceAcknowledgementDisposition(failed, 7, 3, "d2", false, requested, 7)).toBe(
      "ignore",
    );
    expect(deviceAcknowledgementDisposition(failed, 7, 3, "d1", true, requested, 7)).toBe("ignore");
    expect(deviceAcknowledgementDisposition(failed, 7, 3, "d2", true, new Set(), 7)).toBe("ignore");
  });

  it("consumes an older owned acknowledgement without clearing a newer drag", () => {
    expect(deviceAcknowledgementDisposition(failed, 7, 3, "d2", true, new Set([7, 8]), 8)).toBe(
      "consume",
    );
  });
});
