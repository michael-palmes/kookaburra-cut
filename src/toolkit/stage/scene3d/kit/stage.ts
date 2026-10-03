/** Output height the look pixel unit is authored at: `uPx = exportHeight / LOOK_REFERENCE_HEIGHT`, so "2 px" means 2 px of a 1080p frame at every export size. */
export const LOOK_REFERENCE_HEIGHT = 1080;

/** Default `stageFade` window as fractions of the camera-to-stage distance: fragments nearer the camera than `near` vanish, full strength from `far`. Tighter than the sketch harness's 0.55 to 0.95, which let rings creep over content. */
export const STAGE_FADE_WINDOW = { near: 0.75, far: 0.97 } as const;
