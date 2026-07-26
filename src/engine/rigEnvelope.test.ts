import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc } from "./sceneDocSchema";
import { ENVELOPE_SAMPLES, envelopeOverscan, normalizeSceneRig, rigEnvelope } from "./sceneRig";

// The exact 16:9 base frame: what the base camera (z 5, fov 45) sees at the content plane.
const BASE_HEIGHT = 2 * Math.tan((22.5 * Math.PI) / 180) * 5;
const FRAME = { width: BASE_HEIGHT * (16 / 9), height: BASE_HEIGHT };

const track = (raw: NonNullable<SceneDoc["cameraRig"]>) => {
  const t = normalizeSceneRig(raw, "test");
  if (!t) throw new Error("track expected");
  return t;
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("rigEnvelope", () => {
  it("summarises a straight truck's travel", () => {
    const env = rigEnvelope(
      track({
        keys: [
          {
            id: "a",
            tMs: 0,
            pose: { position: [-3, 0.5, 6], aim: { mode: "point", at: [0, 0, 0] } },
          },
          {
            id: "b",
            tMs: 1000,
            pose: { position: [3, 0.5, 2], aim: { mode: "point", at: [0, 0, 0] } },
          },
        ],
        segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
      }),
    );
    expect(env.lateral).toBeCloseTo(3, 6);
    expect(env.vertical).toBeCloseTo(0.5, 6);
    expect(env.minDistance).toBeCloseTo(2, 6);
    expect(env.maxDistance).toBeCloseTo(6, 6);
    expect(env.minFov).toBe(45);
    expect(env.maxFov).toBe(45);
  });

  it("reads a lone key without dividing by a zero span", () => {
    const env = rigEnvelope(
      track({
        keys: [
          { id: "a", tMs: 0, pose: { position: [1, 2, 3], aim: { mode: "point", at: [0, 0, 0] } } },
        ],
        segments: [],
      }),
    );
    expect(env.lateral).toBe(1);
    expect(env.maxDistance).toBe(3);
    expect(env.minDistance).toBe(3);
  });

  it("picks up the authored lens range", () => {
    const env = rigEnvelope(
      track({
        keys: [
          {
            id: "a",
            tMs: 0,
            pose: { position: [0, 0, 5], aim: { mode: "point", at: [0, 0, 0] }, fov: 20 },
          },
          {
            id: "b",
            tMs: 1000,
            pose: { position: [0, 0, 5], aim: { mode: "point", at: [0, 0, 0] }, fov: 70 },
          },
        ],
        segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
      }),
    );
    expect(env.minFov).toBeCloseTo(20, 6);
    expect(env.maxFov).toBeCloseTo(70, 6);
  });

  it("uses a fixed, documented sample count so preview and export can't disagree", () => {
    expect(ENVELOPE_SAMPLES).toBe(64);
  });
});

describe("envelopeOverscan", () => {
  const still = { lateral: 0, vertical: 0, minDistance: 5, maxDistance: 5, minFov: 45, maxFov: 45 };

  it("a camera parked at the base pose needs no more than the base frame", () => {
    expect(envelopeOverscan(still, FRAME)).toBeCloseTo(1, 2);
  });

  it("travel sideways asks for more", () => {
    const moved = { ...still, lateral: 3 };
    expect(envelopeOverscan(moved, FRAME)).toBeGreaterThan(envelopeOverscan(still, FRAME));
  });

  it("a wider lens or a longer pull-back asks for more", () => {
    expect(envelopeOverscan({ ...still, maxFov: 80 }, FRAME)).toBeGreaterThan(
      envelopeOverscan(still, FRAME),
    );
    expect(envelopeOverscan({ ...still, maxDistance: 12 }, FRAME)).toBeGreaterThan(
      envelopeOverscan(still, FRAME),
    );
  });

  it("never returns less than the minimum, so a rig can only ask for MORE", () => {
    expect(envelopeOverscan(still, FRAME, 0, 2)).toBe(2);
  });

  it("a band further from the camera needs less than one nearer it", () => {
    const wide = { ...still, lateral: 2 };
    expect(envelopeOverscan(wide, FRAME, -5)).toBeGreaterThan(envelopeOverscan(wide, FRAME, 1.8));
  });
});
