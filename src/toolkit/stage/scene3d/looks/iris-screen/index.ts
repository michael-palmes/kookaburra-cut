import { TEXT_CALM_PARAM } from "../../kit/stage";
import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { IrisScreen } from "./IrisScreen";
import { IRIS_SCREEN_PRESETS } from "./presets";

/** Iris screen (deco): the Institut du Monde Arabe's lens-iris facade as a drum round the stage, its backlight falling through the apertures as analytic gobo pools (F6) on the floor. */
export const look: Scene3dBackgroundDef = {
  id: "iris-screen",
  name: "Iris screen",
  family: "deco",
  colorSlots: [
    { label: "Screen", fallback: "#1c2524" },
    { label: "Aperture glow", fallback: "#8a6c3c", glow: true },
    { label: "Floor pattern", fallback: "#62533a" },
  ],
  params: {
    radius: { label: "Screen radius", default: 15, min: 11, max: 22, step: 0.5 },
    panels: { label: "Panels round", default: 40, min: 36, max: 72, step: 1 },
    cycle: { label: "Iris cycle (s)", default: 30, min: 20, max: 40, step: 1 },
    sunElevation: { label: "Sun elevation", default: 22, min: 12, max: 40, step: 1 },
    pool: { label: "Floor pools", default: 0.6, min: 0, max: 1, step: 0.01 },
    clearRadius: { label: "Clearing", default: 6, min: 4, max: 10, step: 0.5 },
    textCalm: TEXT_CALM_PARAM,
  },
  Component: IrisScreen,
};

export const presets: Scene3dBackgroundPreset[] = IRIS_SCREEN_PRESETS;
