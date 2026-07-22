import type { SolvedItemRect } from "./layeredScreenshotLayout";
import type { LayeredScreenshotPose, SceneDocLayeredScreenshot } from "./sceneDocSchema";

/** The four animation presets: pure scaffolds replacing the block's `animation` with editable keys seeded from the pose the stack currently shows, so applying one never visibly jumps frame 0. Times clamp inside the scene; every key stays hand-editable in the lane afterwards. */

export type LayeredScreenshotPresetId = "expand-iso" | "flatten" | "zoom-item" | "drift";

/** The isometric pose the builder's snap and the expand preset share. */
export const ISO_AZIMUTH_DEG = 18;
export const ISO_ELEVATION_DEG = 12;
/** Zoom-to-a-screen fills this share of the safe frame's short side. */
const ZOOM_ITEM_FILL = 0.7;

type Animation = NonNullable<SceneDocLayeredScreenshot["animation"]>;

const pose = (p: LayeredScreenshotPose): LayeredScreenshotPose => ({ ...p, pan: [...p.pan] });

function twoKeyTrack(
  from: LayeredScreenshotPose,
  to: LayeredScreenshotPose,
  spanMs: number,
  durationMs: number,
): Animation {
  const end = Math.min(spanMs, Math.max(100, durationMs));
  return {
    keys: [
      { id: "k1", tMs: 0, pose: pose(from) },
      { id: "k2", tMs: Math.round(end), pose: pose(to) },
    ],
    segments: [{ from: "k1", to: "k2", ease: "inOutCubic" }],
  };
}

/** Fan the stack out to the isometric view over ~1.2s. */
export function expandToIsometric(from: LayeredScreenshotPose, durationMs: number): Animation {
  return twoKeyTrack(
    from,
    {
      ...from,
      pan: [...from.pan],
      spread: 1,
      azimuthDeg: ISO_AZIMUTH_DEG,
      elevationDeg: ISO_ELEVATION_DEG,
    },
    1200,
    durationMs,
  );
}

/** The inverse: collapse to the flat, front-on stack. */
export function flattenToFrontOn(from: LayeredScreenshotPose, durationMs: number): Animation {
  return twoKeyTrack(
    from,
    { ...from, pan: [...from.pan], spread: 0, azimuthDeg: 0, elevationDeg: 0 },
    1200,
    durationMs,
  );
}

/** The pose that centres one solved item rect and fills ~70% of the safe frame, front-on (rotation would decentre the analytic pan). `fit` is the stack's auto-fit scale; pan counteracts the item's fitted offset at the derived zoom. */
export function deriveZoomToItemPose(
  base: LayeredScreenshotPose,
  rect: SolvedItemRect,
  fit: number,
  safeWidth: number,
  safeHeight: number,
): LayeredScreenshotPose {
  const zoom =
    fit > 0 && rect.width > 0 && rect.height > 0
      ? ZOOM_ITEM_FILL * Math.min(safeWidth / (fit * rect.width), safeHeight / (fit * rect.height))
      : base.zoom;
  return {
    spread: base.spread,
    azimuthDeg: 0,
    elevationDeg: 0,
    zoom,
    pan: [-rect.x * fit * zoom, -rect.y * fit * zoom],
  };
}

/** Push in on one screen over ~1s. */
export function zoomToItem(
  from: LayeredScreenshotPose,
  rect: SolvedItemRect,
  fit: number,
  safeWidth: number,
  safeHeight: number,
  durationMs: number,
): Animation {
  return twoKeyTrack(
    from,
    deriveZoomToItemPose(from, rect, fit, safeWidth, safeHeight),
    1000,
    durationMs,
  );
}

/** A slow closed drift loop (~7s or the scene, whichever is shorter): the last key IS the first pose, so present-hold looping repeats seamlessly (jump mode, set here). */
export function slowDrift(from: LayeredScreenshotPose, durationMs: number): Animation {
  const end = Math.min(7000, Math.max(1000, durationMs));
  const third = Math.round(end / 3);
  const wobble = (azDelta: number, elDelta: number, zoomMul: number): LayeredScreenshotPose => ({
    ...from,
    pan: [...from.pan],
    azimuthDeg: from.azimuthDeg + azDelta,
    elevationDeg: from.elevationDeg + elDelta,
    zoom: from.zoom * zoomMul,
  });
  return {
    keys: [
      { id: "k1", tMs: 0, pose: pose(from) },
      { id: "k2", tMs: third, pose: wobble(6, 3, 1.04) },
      { id: "k3", tMs: third * 2, pose: wobble(-5, -2, 1.02) },
      { id: "k4", tMs: Math.round(end), pose: pose(from) },
    ],
    segments: [
      { from: "k1", to: "k2", ease: "inOutSine" },
      { from: "k2", to: "k3", ease: "inOutSine" },
      { from: "k3", to: "k4", ease: "inOutSine" },
    ],
    presentLoop: { mode: "jump" },
  };
}
