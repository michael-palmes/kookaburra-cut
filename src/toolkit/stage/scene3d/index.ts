import { ContourField } from "./ContourField";
import { GridHall } from "./GridHall";
import { GridPlain } from "./GridPlain";
import { GridShell } from "./GridShell";
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
  "grid-shell": {
    id: "grid-shell",
    name: "Grid shell",
    colorSlots: [{ label: "Lines", fallback: "#815a3d" }],
    params: {
      radius: { label: "Radius", default: 22, min: 16, max: 45, step: 1 },
      latCount: { label: "Rings", default: 16, min: 6, max: 24, step: 1 },
      lonCount: { label: "Meridians", default: 24, min: 8, max: 32, step: 1 },
      horizonBias: { label: "Horizon bias", default: 0.5, min: 0, max: 1, step: 0.01 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
      opacity: { label: "Line strength", default: 0.8, min: 0.1, max: 1, step: 0.01 },
    },
    Component: GridShell,
  },
  "grid-hall": {
    id: "grid-hall",
    name: "Grid hall",
    colorSlots: [{ label: "Lines", fallback: "#45648f" }],
    params: {
      width: { label: "Width", default: 16, min: 10, max: 30, step: 1 },
      depth: { label: "Depth", default: 28, min: 16, max: 48, step: 1 },
      height: { label: "Height", default: 12, min: 6, max: 20, step: 1 },
      spacing: { label: "Spacing", default: 1.2, min: 0.8, max: 4, step: 0.1 },
      clearRadius: { label: "Clearing", default: 4, min: 0, max: 24, step: 0.5 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
      opacity: { label: "Line strength", default: 0.8, min: 0.1, max: 1, step: 0.01 },
    },
    Component: GridHall,
  },
  "contour-field": {
    id: "contour-field",
    name: "Contour field",
    colorSlots: [{ label: "Lines", fallback: "#3e6783" }],
    params: {
      levels: { label: "Levels", default: 10, min: 4, max: 16, step: 1 },
      hilliness: { label: "Hilliness", default: 1, min: 0.2, max: 2, step: 0.05 },
      scale: { label: "Scale", default: 14, min: 10, max: 40, step: 1 },
      height: { label: "Height", default: -2, min: -6, max: 0, step: 0.1 },
      clearRadius: { label: "Clearing", default: 4, min: 0, max: 24, step: 0.5 },
      fadeRadius: { label: "Fade distance", default: 44, min: 16, max: 90, step: 1 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
      opacity: { label: "Line strength", default: 0.8, min: 0.1, max: 1, step: 0.01 },
    },
    Component: ContourField,
  },
};

export const SCENE3D_BACKGROUND_IDS: string[] = [
  "grid-plain",
  "grid-shell",
  "grid-hall",
  "contour-field",
];

export {
  SCENE3D_BACKGROUND_PRESETS,
  type Scene3dBackgroundPreset,
  scene3dThemeAnchor,
} from "./presets";
export type { Scene3dBackgroundDef, Scene3dLookProps, Scene3dParamDef } from "./types";
