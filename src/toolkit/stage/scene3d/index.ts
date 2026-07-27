import { ContourField } from "./ContourField";
import { DriftSlabs } from "./DriftSlabs";
import { GridHall } from "./GridHall";
import { GridPlain } from "./GridPlain";
import { GridShell } from "./GridShell";
import { HaloRings } from "./HaloRings";
import { OrbField } from "./OrbField";
import { SkylinePrisms } from "./SkylinePrisms";
import type { Scene3dBackgroundDef } from "./types";

export const SCENE3D_BACKGROUNDS: Record<string, Scene3dBackgroundDef> = {
  "grid-plain": {
    id: "grid-plain",
    name: "Grid plain",
    colorSlots: [{ label: "Lines", fallback: "#3b5c7d" }],
    params: {
      spacing: { label: "Spacing", default: 1.2, min: 0.6, max: 4, step: 0.1 },
      height: { label: "Height", default: -1.3, min: -6, max: 0, step: 0.1 },
      clearRadius: { label: "Clearing", default: 4, min: 0, max: 24, step: 0.5 },
      fadeRadius: { label: "Fade distance", default: 40, min: 16, max: 90, step: 1 },
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
      radius: { label: "Radius", default: 18, min: 12, max: 45, step: 1 },
      latCount: { label: "Rings", default: 11, min: 6, max: 24, step: 1 },
      lonCount: { label: "Meridians", default: 32, min: 8, max: 48, step: 1 },
      horizonBias: { label: "Horizon bias", default: 0.5, min: 0, max: 1, step: 0.01 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
      opacity: { label: "Line strength", default: 0.7, min: 0.1, max: 1, step: 0.01 },
    },
    Component: GridShell,
  },
  "grid-hall": {
    id: "grid-hall",
    name: "Grid hall",
    colorSlots: [{ label: "Lines", fallback: "#45648f" }],
    params: {
      width: { label: "Width", default: 19, min: 10, max: 30, step: 1 },
      depth: { label: "Depth", default: 48, min: 16, max: 70, step: 1 },
      height: { label: "Height", default: 12, min: 6, max: 20, step: 1 },
      spacing: { label: "Spacing", default: 1.2, min: 0.8, max: 4, step: 0.1 },
      clearRadius: { label: "Clearing", default: 3.5, min: 0, max: 24, step: 0.5 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
      opacity: { label: "Line strength", default: 0.9, min: 0.1, max: 1, step: 0.01 },
    },
    Component: GridHall,
  },
  "contour-field": {
    id: "contour-field",
    name: "Contour field",
    colorSlots: [{ label: "Lines", fallback: "#3e6783" }],
    params: {
      levels: { label: "Levels", default: 11, min: 4, max: 16, step: 1 },
      hilliness: { label: "Hilliness", default: 0.5, min: 0.2, max: 2, step: 0.05 },
      scale: { label: "Scale", default: 10, min: 6, max: 40, step: 1 },
      height: { label: "Height", default: -2, min: -6, max: 0, step: 0.1 },
      clearRadius: { label: "Clearing", default: 8.5, min: 0, max: 24, step: 0.5 },
      fadeRadius: { label: "Fade distance", default: 60, min: 16, max: 90, step: 1 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
      opacity: { label: "Line strength", default: 0.9, min: 0.1, max: 1, step: 0.01 },
    },
    Component: ContourField,
  },
  "drift-slabs": {
    id: "drift-slabs",
    name: "Drift slabs",
    lit: true,
    colorSlots: [
      { label: "Shapes", fallback: "#35465e" },
      { label: "Accent", fallback: "#7b553a" },
    ],
    params: {
      count: { label: "Count", default: 7, min: 3, max: 10, step: 1 },
      spread: { label: "Spread", default: 12, min: 8, max: 18, step: 0.5 },
      depth: { label: "Depth", default: 12, min: 9, max: 20, step: 0.5 },
      size: { label: "Size", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
    },
    Component: DriftSlabs,
  },
  "orb-field": {
    id: "orb-field",
    name: "Orb field",
    lit: true,
    colorSlots: [
      { label: "Orbs", fallback: "#33475b" },
      { label: "Accent", fallback: "#765738" },
    ],
    params: {
      count: { label: "Count", default: 6, min: 3, max: 10, step: 1 },
      spread: { label: "Spread", default: 12, min: 8, max: 18, step: 0.5 },
      depth: { label: "Depth", default: 13, min: 9, max: 20, step: 0.5 },
      size: { label: "Size", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
    },
    Component: OrbField,
  },
  "halo-rings": {
    id: "halo-rings",
    name: "Halo rings",
    lit: true,
    colorSlots: [
      { label: "Rings", fallback: "#35475e" },
      { label: "Accent", fallback: "#785639" },
    ],
    params: {
      count: { label: "Count", default: 3, min: 2, max: 5, step: 1 },
      spread: { label: "Spread", default: 10, min: 6, max: 16, step: 0.5 },
      depth: { label: "Depth", default: 13, min: 9, max: 20, step: 0.5 },
      size: { label: "Size", default: 1, min: 0.6, max: 1.5, step: 0.05 },
      tube: { label: "Tube", default: 0.16, min: 0.08, max: 0.35, step: 0.01 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
    },
    Component: HaloRings,
  },
  "skyline-prisms": {
    id: "skyline-prisms",
    name: "Skyline prisms",
    lit: true,
    colorSlots: [
      { label: "Prisms", fallback: "#36465f" },
      { label: "Accent", fallback: "#765738" },
    ],
    params: {
      count: { label: "Count", default: 9, min: 5, max: 14, step: 1 },
      spread: { label: "Spread", default: 14, min: 10, max: 22, step: 0.5 },
      depth: { label: "Depth", default: 14, min: 10, max: 22, step: 0.5 },
      tallest: { label: "Tallest", default: 8, min: 4, max: 12, step: 0.5 },
      drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 },
    },
    Component: SkylinePrisms,
  },
};

export const SCENE3D_BACKGROUND_IDS: string[] = [
  "grid-plain",
  "grid-shell",
  "grid-hall",
  "contour-field",
  "drift-slabs",
  "orb-field",
  "halo-rings",
  "skyline-prisms",
];

export {
  SCENE3D_BACKGROUND_PRESETS,
  type Scene3dBackgroundPreset,
  scene3dThemeAnchor,
} from "./presets";
export type { Scene3dBackgroundDef, Scene3dLookProps, Scene3dParamDef } from "./types";
