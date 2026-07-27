import { GridPlain } from "./GridPlain";
import type { Scene3dBackgroundDef } from "./types";

export const SCENE3D_BACKGROUNDS: Record<string, Scene3dBackgroundDef> = {
  "grid-plain": {
    id: "grid-plain",
    name: "Grid plain",
    colorSlots: [{ label: "Lines", fallback: "#3b5c7d" }],
    params: {
      spacing: { label: "Spacing", default: 1.2, min: 0.6, max: 4, step: 0.1 },
      height: { label: "Height", default: -2, min: -6, max: 0, step: 0.1 },
      clearRadius: { label: "Clearing", default: 4, min: 0, max: 24, step: 0.5 },
      fadeRadius: { label: "Fade distance", default: 44, min: 16, max: 90, step: 1 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
      opacity: { label: "Line strength", default: 0.8, min: 0.1, max: 1, step: 0.01 },
    },
    Component: GridPlain,
  },
};

export const SCENE3D_BACKGROUND_IDS: string[] = ["grid-plain"];

export {
  SCENE3D_BACKGROUND_PRESETS,
  type Scene3dBackgroundPreset,
  scene3dThemeAnchor,
} from "./presets";
export type { Scene3dBackgroundDef, Scene3dLookProps, Scene3dParamDef } from "./types";
