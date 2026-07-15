/** Pure placement math for the fixed (camera-locked, frame-filling) background, golden-tested (the `engine/ease.ts` pinning pattern): every value below feeds the per-draw `matrixWorld` write in `FixedBackdrop`, so the formulas and constants are EXPORT CONTRACT; deterministic since the camera state per render is a pure function of the clock (the compositor seams apply project/per-scene/per-target poses before each render) and everything here is a pure function of that camera state, no clock reads, no randomness, no history. */

/** View-space distance of the background quad (must stay well inside camera far). */
export const FIXED_BG_DISTANCE = 50;
/** Drawn first; nothing else in the codebase sets a renderOrder. */
export const FIXED_BG_RENDER_ORDER = -100;
/** Parallax anchor displacement is clamped to ±this many NDC units (a full frame = 2). */
export const FIXED_BG_NDC_CLAMP = 2;

const DEG2RAD = Math.PI / 180;

/** Quad overscan: the 0.1% base kills FP/MSAA edge seams where the quad edge meets the frame edge; the `2p` term covers the full parallax travel (offset ≤ 2p·halfExtent per axis under the NDC clamp). */
export function fixedOverscan(parallax: number): number {
  return 1.001 + 2 * parallax;
}

/** Frustum-filling quad size at FIXED_BG_DISTANCE for a vertical fov (deg) + aspect. */
export function fixedQuadSize(
  fovDeg: number,
  aspect: number,
  parallax: number,
): { width: number; height: number } {
  const halfH = FIXED_BG_DISTANCE * Math.tan(fovDeg * 0.5 * DEG2RAD);
  const o = fixedOverscan(parallax);
  return { width: 2 * halfH * aspect * o, height: 2 * halfH * o };
}

/** Lateral camera-space offset for the parallax drift: `anchorNdc*` is the world origin projected through the CURRENT camera (under the base pose it projects to (0,0), so its NDC IS the content's screen displacement), and the background moves at `parallax ×` that displacement; fov-invariant by construction (zooming does not move the origin's NDC), and `anchorInFront=false` (the anchor is behind the camera, a pathological orbit) holds the offset at 0. */
export function fixedParallaxOffset(
  fovDeg: number,
  aspect: number,
  parallax: number,
  anchorNdcX: number,
  anchorNdcY: number,
  anchorInFront: boolean,
): { x: number; y: number } {
  if (parallax <= 0 || !anchorInFront) return { x: 0, y: 0 };
  const halfH = FIXED_BG_DISTANCE * Math.tan(fovDeg * 0.5 * DEG2RAD);
  const halfW = halfH * aspect;
  const cx = Math.min(FIXED_BG_NDC_CLAMP, Math.max(-FIXED_BG_NDC_CLAMP, anchorNdcX));
  const cy = Math.min(FIXED_BG_NDC_CLAMP, Math.max(-FIXED_BG_NDC_CLAMP, anchorNdcY));
  return { x: parallax * cx * halfW, y: parallax * cy * halfH };
}

/** Centred cover-crop UV window (CSS `background-size: cover` semantics) for an image of `imageAspect` filling a frame of `frameAspect`; applied to PER-INSTANCE geometry UVs, never `texture.repeat/offset`, since the bundled/drei texture caches are shared and mutating them would fight the world-space ImagePlane's own crop of the same texture. */
export function fixedCoverCrop(
  imageAspect: number,
  frameAspect: number,
): { u0: number; v0: number; u1: number; v1: number } {
  if (imageAspect > frameAspect) {
    const rx = frameAspect / imageAspect;
    const off = (1 - rx) / 2;
    return { u0: off, v0: 0, u1: off + rx, v1: 1 };
  }
  const ry = imageAspect / frameAspect;
  const off = (1 - ry) / 2;
  return { u0: 0, v0: off, u1: 1, v1: off + ry };
}
