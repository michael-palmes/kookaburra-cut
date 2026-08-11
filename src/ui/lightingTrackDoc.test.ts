import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { lightingTrackForTarget, writeLightingTrackForTarget } from "./lightingTrackDoc";

const sceneTrack = {
  keys: [{ id: "scene", tMs: 0, pose: { ambient: 0.2 } }],
  segments: [],
};
const afterTrack = {
  keys: [{ id: "after", tMs: 0, pose: { ambient: 0.8 } }],
  segments: [],
};

describe("lightingTrackDoc targets", () => {
  it("reads scene and comparison-B tracks independently", () => {
    const doc: SceneDoc = {
      version: 1,
      lighting: { ...sceneTrack, ambient: 0.4 },
      compare: { b: { lighting: { ...afterTrack, ambient: 0.6 } } },
    };

    expect(lightingTrackForTarget(doc, "scene")).toEqual(sceneTrack);
    expect(lightingTrackForTarget(doc, "compareB")).toEqual(afterTrack);
  });

  it("writes only the selected lighting field and preserves sibling compare data", () => {
    const doc: SceneDoc = {
      version: 1,
      lighting: { ...sceneTrack, ambient: 0.4 },
      compare: { value: 0.35, b: { themeId: "paper", lighting: { ambient: 0.6 } } },
    };
    const written = writeLightingTrackForTarget(doc, "compareB", afterTrack);

    expect(written.lighting).toEqual(doc.lighting);
    expect(written.compare?.value).toBe(0.35);
    expect(written.compare?.b?.themeId).toBe("paper");
    expect(written.compare?.b?.lighting).toEqual({ ambient: 0.6, ...afterTrack });
    expect(doc.compare?.b?.lighting?.keys).toBeUndefined();
  });

  it("materialises the comparison path without changing the scene track", () => {
    expect(writeLightingTrackForTarget(undefined, "compareB", afterTrack)).toEqual({
      version: 1,
      compare: { b: { lighting: afterTrack } },
    });
  });
});
