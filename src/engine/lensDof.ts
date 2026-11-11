/** Lens depth of field: the thin-lens circle of confusion behind dof mode "lens". Pure (no three.js, no clock reads); effects.ts turns the result into LensDofEffect uniforms. Distances are world units, converted to millimetres at the phone fit, so an f-stop reads the way it would on a real lens shooting a real handset. See docs/camera.md and docs/determinism.md. */

/** Millimetres per world unit: devices fit their height to 2.6 units, and a 146.6 mm handset is the reference subject. EXPORT CONTRACT. */
export const LENS_MM_PER_UNIT = 146.6 / 2.6;
/** The CoC ceiling as a fraction of image height (real macro blur runs far past it; beyond this a wash is a wash). EXPORT CONTRACT. */
export const LENS_COC_MAX = 0.05;
/** The gather's working scale; the sharp side of the composite is always full resolution. EXPORT CONTRACT. */
export const LENS_RESOLUTION_SCALE = 0.5;
/** Most gather taps a pixel takes (fewer for small discs, one per ~4 half-res px²). EXPORT CONTRACT. */
export const LENS_TAPS = 128;

export const LENS_FSTOP_MIN = 0.7;
export const LENS_FSTOP_MAX = 64;
export const LENS_FOCAL_MIN = 4;
export const LENS_FOCAL_MAX = 1200;
export const LENS_SENSOR_MIN = 2;
export const LENS_SENSOR_MAX = 70;
/** Defaults until a key authors them: f/4 on a full-frame sensor (24 mm along the fov axis). */
export const LENS_FSTOP_DEFAULT = 4;
export const LENS_SENSOR_DEFAULT = 24;

export interface LensParams {
  /** Aperture as an f-number. */
  fStop: number;
  /** Focal length in mm; null derives it from the sensor and the camera's vertical fov. */
  focalMm: number | null;
  /** Sensor extent along the fov axis in mm (ignored when focalMm is set). */
  sensorMm: number;
  /** Focus distance in world units, measured along the view axis. */
  focus: number;
  /** 0..1 aperture scale (0 is a pinhole). */
  blur: number;
}

/** The lens a frame resolves to: what the effect needs to compute CoC per pixel. */
export interface LensUniforms {
  /** Signed CoC at infinity as a fraction of image height (CoC(d) = cocInf * (1 - focus / d)). */
  cocInf: number;
  focus: number;
  focalMm: number;
  sensorMm: number;
}

/** `projY` is the projection matrix's [5] entry, 1 / tan(fov / 2) with zoom applied. Focal length and sensor are tied by the fov: authoring one derives the other. */
export function lensUniforms(p: LensParams, projY: number): LensUniforms {
  const halfTan = 1 / Math.max(projY, 1e-6);
  const focalMm = p.focalMm ?? p.sensorMm / 2 / halfTan;
  const sensorMm = p.focalMm !== null ? 2 * p.focalMm * halfTan : p.sensorMm;
  // Focus inside the focal length cannot form an image; pin it just outside so the CoC saturates at the ceiling instead of flipping sign.
  const focusMm = Math.max(p.focus * LENS_MM_PER_UNIT, focalMm * 1.001);
  const apertureMm = focalMm / p.fStop;
  const cocInfMm = (apertureMm * focalMm) / (focusMm - focalMm);
  return {
    cocInf: (Math.max(0, p.blur) * cocInfMm) / sensorMm,
    focus: p.focus,
    focalMm,
    sensorMm,
  };
}

/** Signed CoC (fraction of image height) of a point `distance` units down the view axis: negative in front of focus, positive behind, clamped to the ceiling. The shader's formula, mirrored for tests. */
export function lensCoc(u: LensUniforms, distance: number): number {
  const raw = u.cocInf * (1 - u.focus / Math.max(distance, 1e-6));
  return Math.min(LENS_COC_MAX, Math.max(-LENS_COC_MAX, raw));
}
