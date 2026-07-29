import { describe, expect, it } from "vitest";
import { RECORDING_INSETS } from "../engine/sceneVideoWindow";
import { detectWindowRecordingPixels } from "./windowRecordingDetect";

/** Synthesises a poster: black everywhere, a bright window inside the given insets (poster px). */
function poster(
  w: number,
  h: number,
  insets: { left: number; right: number; top: number; bottom: number },
  windowLevel = 245,
  marginLevel = 3,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inWindow =
        x >= insets.left && x < w - insets.right && y >= insets.top && y < h - insets.bottom;
      const v = inWindow ? windowLevel : marginLevel;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

// The measured example: 1800x1122 at poster scale 640/1800.
const VIDEO_W = 1800;
const VIDEO_H = 1122;
const PW = 640;
const PH = Math.round((VIDEO_H / VIDEO_W) * PW); // 399
const S = PW / VIDEO_W;
const SCALED = {
  left: Math.round(RECORDING_INSETS.left * S),
  right: Math.round(RECORDING_INSETS.right * S),
  top: Math.round(RECORDING_INSETS.top * S),
  bottom: Math.round(RECORDING_INSETS.bottom * S),
};

describe("detectWindowRecordingPixels", () => {
  it("accepts a poster with the capture margins in the right places", () => {
    const data = poster(PW, PH, SCALED);
    expect(detectWindowRecordingPixels(data, PW, PH, VIDEO_W, VIDEO_H)).toBe(true);
  });

  it("tolerates a pixel of scaling slop and JPEG-level noise", () => {
    const off = { ...SCALED, left: SCALED.left + 1, top: SCALED.top - 1 };
    const data = poster(PW, PH, off, 245, 9);
    expect(detectWindowRecordingPixels(data, PW, PH, VIDEO_W, VIDEO_H)).toBe(true);
  });

  it("rejects margins in the wrong widths (a letterboxed clip)", () => {
    const wrong = { left: SCALED.left + 8, right: SCALED.right + 8, top: 0, bottom: 0 };
    const data = poster(PW, PH, wrong);
    expect(detectWindowRecordingPixels(data, PW, PH, VIDEO_W, VIDEO_H)).toBe(false);
  });

  it("rejects a full-bleed clip and an all-black poster", () => {
    const full = poster(PW, PH, { left: 0, right: 0, top: 0, bottom: 0 });
    expect(detectWindowRecordingPixels(full, PW, PH, VIDEO_W, VIDEO_H)).toBe(false);
    const black = poster(PW, PH, { left: 0, right: 0, top: 0, bottom: 0 }, 3, 3);
    expect(detectWindowRecordingPixels(black, PW, PH, VIDEO_W, VIDEO_H)).toBe(false);
  });

  it("rejects margins that are dark grey rather than black", () => {
    const data = poster(PW, PH, SCALED, 245, 40);
    expect(detectWindowRecordingPixels(data, PW, PH, VIDEO_W, VIDEO_H)).toBe(false);
  });

  it("never fires on a clip too small to carry the margins", () => {
    const data = poster(64, 40, { left: 4, right: 4, top: 3, bottom: 5 });
    expect(detectWindowRecordingPixels(data, 64, 40, 180, 112)).toBe(false);
  });
});
