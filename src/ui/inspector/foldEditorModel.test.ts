import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  addFoldAnimation,
  FOLD_ANIMATION_EASE,
  FOLD_ANIMATION_MS,
  FOLD_PRESETS,
  foldDegEditing,
  writeFoldDeg,
} from "./foldEditorModel";

const still = (): SceneDoc => ({
  version: 1,
  devices: [
    { id: "duo", model: "iphone-duo" },
    { id: "phone", model: "iphone-17-pro" },
  ],
});

const animated = (): SceneDoc => ({
  ...still(),
  deviceTrack: {
    keys: [
      { id: "k1", tMs: 0, pose: { duo: { foldDeg: 0 }, phone: { scale: 1.2 } } },
      { id: "k2", tMs: 1000, pose: { duo: { foldDeg: 180 } } },
    ],
    segments: [{ from: "k1", to: "k2", ease: "linear" }],
  },
});

describe("the fold presets", () => {
  it("run closed to open, the four poses the inspector offers", () => {
    expect(FOLD_PRESETS.map((preset) => preset.deg)).toEqual([0, 90, 120, 180]);
  });
});

describe("reading and writing the fold angle", () => {
  it("shows the model default, then the device's own angle", () => {
    const doc = still();
    expect(foldDegEditing(doc, "duo", 0, 180)).toBe(180);
    writeFoldDeg(doc, "duo", 120, 0);
    expect(doc.devices?.[0].foldDeg).toBe(120);
    expect(foldDegEditing(doc, "duo", 0, 180)).toBe(120);
  });

  it("shows and writes the key nearest the playhead, never an in-between value", () => {
    const doc = animated();
    expect(foldDegEditing(doc, "duo", 400, 180)).toBe(0);
    expect(foldDegEditing(doc, "duo", 800, 180)).toBe(180);
    writeFoldDeg(doc, "duo", 150, 800);
    expect(foldDegEditing(doc, "duo", 800, 180)).toBe(150);
    // A plain device write would be invisible here: the keys own the fold.
    expect(doc.devices?.[0].foldDeg).toBeUndefined();
    expect(doc.deviceTrack?.keys[1].pose.duo.foldDeg).toBe(150);
    expect(doc.deviceTrack?.keys[0].pose.duo.foldDeg).toBe(0);
  });

  it("keeps the rest of a key's pose when it takes an angle", () => {
    const doc = animated();
    writeFoldDeg(doc, "phone", 40, 0);
    expect(doc.deviceTrack?.keys[0].pose.phone).toEqual({ scale: 1.2, foldDeg: 40 });
  });
});

describe("one-click unfold and fold", () => {
  it("adds a closed-to-open pair at the playhead with the tuned ease", () => {
    const doc = still();
    expect(addFoldAnimation(doc, "duo", "unfold", 400, 5000, 180)).toBe(true);
    const track = doc.deviceTrack;
    expect(track?.keys.map((key) => key.tMs)).toEqual([400, 400 + FOLD_ANIMATION_MS]);
    expect(track?.keys.map((key) => key.pose.duo.foldDeg)).toEqual([0, 180]);
    expect(track?.segments).toEqual([{ from: "k1", to: "k2", ease: FOLD_ANIMATION_EASE }]);
    // Seeded with what every device shows, so the phone holds still.
    expect(track?.keys[0].pose.phone).toEqual(track?.keys[1].pose.phone);
  });

  it("folds the other way, and truncates at the scene's end", () => {
    const doc = still();
    expect(addFoldAnimation(doc, "duo", "fold", 1500, 2000, 180)).toBe(true);
    expect(doc.deviceTrack?.keys.map((key) => key.tMs)).toEqual([1500, 2000]);
    expect(doc.deviceTrack?.keys.map((key) => key.pose.duo.foldDeg)).toEqual([180, 0]);
  });

  it("chains off a key already at the playhead, which takes the starting angle", () => {
    const doc = animated();
    expect(addFoldAnimation(doc, "duo", "fold", 1000, 5000, 180)).toBe(true);
    expect(doc.deviceTrack?.keys).toHaveLength(3);
    expect(doc.deviceTrack?.keys[1].pose.duo.foldDeg).toBe(180);
    expect(doc.deviceTrack?.segments[1]).toMatchObject({ from: "k2", ease: FOLD_ANIMATION_EASE });
  });

  it("refuses inside an existing animation and leaves the doc untouched", () => {
    const doc = animated();
    const before = structuredClone(doc);
    expect(addFoldAnimation(doc, "duo", "unfold", 500, 5000, 180)).toBe(false);
    expect(doc).toEqual(before);
  });
});
