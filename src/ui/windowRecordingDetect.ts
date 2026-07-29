import type { MediaMeta } from "../engine/media";
import { fsUrl } from "../engine/media";
import { RECORDING_INSETS } from "../engine/sceneVideoWindow";

/** Editor-side heuristic for the video window's pick flow: does this clip look like a raw macOS window recording (pure-black capture margins in exactly the known widths)? Runs on the cached 640px poster, only ever decides the initial state of the doc's `recording` flag, and fails to `false` so a pick can never block on it. */

/** JPEG noise on the pure-black margins stays comfortably below this. */
const BLACK_MAX = 14;
/** A column/row this bright counts as window content (a dark-mode window still peaks above it at the hairline). */
const CONTENT_MIN = 32;
/** Measured inset may differ from expected by this many poster pixels (scaling + JPEG ringing). */
const TOLERANCE = 2;

interface Bands {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** First row/column from each side whose brightest pixel exceeds CONTENT_MIN; null when a side never does (an all-black poster is not a window recording). */
function measuredInsets(data: Uint8ClampedArray, w: number, h: number): Bands | null {
  const bright = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]);
  };
  const colHas = (x: number) => {
    for (let y = 0; y < h; y++) if (bright(x, y) > CONTENT_MIN) return true;
    return false;
  };
  const rowHas = (y: number) => {
    for (let x = 0; x < w; x++) if (bright(x, y) > CONTENT_MIN) return true;
    return false;
  };
  let left = 0;
  while (left < w && !colHas(left)) left++;
  if (left >= w) return null;
  let right = 0;
  while (right < w && !colHas(w - 1 - right)) right++;
  let top = 0;
  while (top < h && !rowHas(top)) top++;
  let bottom = 0;
  while (bottom < h && !rowHas(h - 1 - bottom)) bottom++;
  return { left, right, top, bottom };
}

/** True when the margin region outside the given insets is essentially pure black (JPEG noise allowed). */
function marginsBlack(data: Uint8ClampedArray, w: number, h: number, insets: Bands): boolean {
  const black = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]) <= BLACK_MAX;
  };
  // Sample the four bands sparsely; a couple of noisy pixels are fine, a lit margin is not.
  let bad = 0;
  let total = 0;
  const step = 2;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < insets.left - 1; x += step) {
      total++;
      if (!black(x, y)) bad++;
    }
    for (let x = w - insets.right + 1; x < w; x += step) {
      total++;
      if (!black(x, y)) bad++;
    }
  }
  for (let x = 0; x < w; x += step) {
    for (let y = 0; y < insets.top - 1; y += step) {
      total++;
      if (!black(x, y)) bad++;
    }
    for (let y = h - insets.bottom + 1; y < h; y += step) {
      total++;
      if (!black(x, y)) bad++;
    }
  }
  return total > 0 && bad / total < 0.002;
}

/** Pure core: RGBA poster pixels + the clip's intrinsic size → window-recording verdict. The signature is the four capture margins, scaled to the poster, matching within TOLERANCE, with pure black outside them. */
export function detectWindowRecordingPixels(
  data: Uint8ClampedArray,
  posterW: number,
  posterH: number,
  videoW: number,
  videoH: number,
): boolean {
  if (posterW <= 0 || posterH <= 0 || videoW <= 0 || videoH <= 0) return false;
  const scale = posterW / videoW;
  const expected: Bands = {
    left: Math.round(RECORDING_INSETS.left * scale),
    right: Math.round(RECORDING_INSETS.right * scale),
    top: Math.round(RECORDING_INSETS.top * scale),
    bottom: Math.round(RECORDING_INSETS.bottom * scale),
  };
  // A capture too small to carry the margins can never crop, so never auto-enable.
  if (expected.left < 4 || expected.top < 4 || expected.bottom < 4) return false;
  const measured = measuredInsets(data, posterW, posterH);
  if (!measured) return false;
  const sides: (keyof Bands)[] = ["left", "right", "top", "bottom"];
  if (sides.some((s) => Math.abs(measured[s] - expected[s]) > TOLERANCE)) return false;
  return marginsBlack(data, posterW, posterH, measured);
}

/** Load the poster and run the pixel core; any failure (no poster, decode error) is a quiet `false`. */
export async function detectWindowRecording(meta: MediaMeta | null): Promise<boolean> {
  if (meta?.kind !== "video" || !meta.posterPath) return false;
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = fsUrl(meta.posterPath);
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return detectWindowRecordingPixels(data, canvas.width, canvas.height, meta.width, meta.height);
  } catch (e) {
    console.warn("[videoWindow] window-recording detection failed:", e);
    return false;
  }
}
