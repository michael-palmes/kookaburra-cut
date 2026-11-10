import { describe, expect, it } from "vitest";
import { CAMERA } from "../../../engine/format";
import type { SceneDoc } from "../../../engine/sceneDocSchema";
import { openingLens } from "./SpotBeam";

const doc = (d: Partial<SceneDoc>) => ({ version: 1, ...d }) as SceneDoc;
const pose = { aim: { mode: "point", at: [0, 0, 0] } };

describe("openingLens", () => {
  it("takes the earliest rig key under rig mode", () => {
    const keys = [
      { id: "b", tMs: 2000, pose: { ...pose, position: [9, 9, 9] } },
      { id: "a", tMs: 0, pose: { ...pose, position: [0, -1, 11] } },
    ];
    expect(openingLens(doc({ cameraMode: "rig", cameraRig: { keys } } as never))).toEqual([
      0, -1, 11,
    ]);
  });

  it("falls back to the orbit's first key, then the default camera", () => {
    const orbit = { target: [0, 0, 0], azimuthDeg: 0, elevationDeg: 0, distance: 5 };
    const camera = { keys: [{ id: "k", tMs: 0, pose: orbit }], segments: [] };
    expect(openingLens(doc({ cameraMode: "rig", camera } as never))).toEqual([0, 0, 5]);
    expect(openingLens(null)).toEqual([...CAMERA.position]);
  });
});
