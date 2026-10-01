import type { Scene3dParamDef } from "../types";

/** Output height the look pixel unit is authored at: `uPx = exportHeight / LOOK_REFERENCE_HEIGHT`, so "2 px" means 2 px of a 1080p frame at every export size. */
export const LOOK_REFERENCE_HEIGHT = 1080;

/** Default `stageFade` window as fractions of the camera-to-stage distance: fragments nearer the camera than `near` vanish, full strength from `far`. Tighter than the sketch harness's 0.55 to 0.95, which let rings creep over content. */
export const STAGE_FADE_WINDOW = { near: 0.75, far: 0.97 } as const;

/** Default calm halo: an ellipse at the stage's depth, half-axes from the content volume (x +-4, y +-2), weight 1 inside `1 - feather` and 0 beyond `1 + feather` of the ellipse radius. */
export const STAGE_HALO = { halfWidth: 4, halfHeight: 2, feather: 0.35 } as const;

/** The shared F13 slider: how strongly a look flattens tone, grain and highlights behind the stage. Looks add it as `params.textCalm` and feed it to `calmWeight()`. */
export const TEXT_CALM_PARAM: Scene3dParamDef = {
  label: "Text band calm",
  default: 0.6,
  min: 0,
  max: 1,
  step: 0.01,
};
