import { stageSpot } from "../../kit";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { LAMP_ELEVATION_DEG, lampOrbitAzimuth } from "./lace";
import { ShadowLace } from "./ShadowLace";

export const look: Scene3dBackgroundDef = {
  id: "shadow-lace",
  name: "Shadow lace",
  family: "painted",
  colorSlots: [
    { label: "Silhouette", fallback: "#0e0c15" },
    { label: "Glow inner", fallback: "#6b5236" },
    { label: "Lamp", fallback: "#ba884e", glow: true },
  ],
  params: {
    density: { label: "Density", default: 1, min: 0.3, max: 1.6, step: 0.05 },
    plantHeight: { label: "Plant height", default: 1, min: 0.6, max: 1.4, step: 0.05 },
    sway: { label: "Sway (deg)", default: 2, min: 0, max: 5, step: 0.1 },
    stepFps: { label: "Step fps", default: 10, min: 6, max: 24, step: 1 },
    farTint: { label: "Far ring tint", default: 0.4, min: 0, max: 0.8, step: 0.01 },
    lampAzimuth: { label: "Lamp azimuth", default: 36, min: -180, max: 180, step: 1 },
    grain: { label: "Grain", default: 0.35, min: 0, max: 1, step: 0.01 },
  },
  Component: ShadowLace,
};

/** Matching rig: a low warm sun at the lamp rims a device from behind, a soft front fill in the glow colour keeps its face readable, over a dim sunset environment. */
function lampLighting(
  mode: "light" | "dark",
  glow: string,
  lampAzimuth: number,
): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:sunset", intensity: dark ? 0.35 : 0.7, rotationDeg: 0 },
    sun: {
      azimuthDeg: Math.round(lampOrbitAzimuth(lampAzimuth)),
      elevationDeg: Math.round(LAMP_ELEVATION_DEG),
      intensity: dark ? 2.4 : 1.8,
      kelvin: 2700,
      angularDeg: 2,
    },
    ambient: dark ? 0.15 : 0.35,
    lights: [
      stageSpot("bg3d-lace-fill", {
        azimuthDeg: -20,
        elevationDeg: 18,
        distance: 9,
        irradiance: dark ? 0.35 : 0.5,
        coneDeg: 40,
        color: glow,
      }),
    ],
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: lampLighting(mode, p.colors[1], p.params?.lampAzimuth ?? 36),
});

/** Tasmanian forests. The backing is the shell's outer glow. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Leatherwood",
    colors: ["#a395a8", "#f7f0e4", "#f1d49f"],
    backing: "#e6d0d2",
    speed: 1,
    params: {
      density: 1,
      plantHeight: 1,
      sway: 2,
      stepFps: 10,
      farTint: 0.4,
      lampAzimuth: 36,
      grain: 0.35,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Mount Field",
    colors: ["#899a95", "#f2f1e2", "#eed9a6"],
    backing: "#dfe3da",
    speed: 0.9,
    params: {
      density: 1.3,
      plantHeight: 1.15,
      sway: 1.5,
      stepFps: 8,
      farTint: 0.5,
      lampAzimuth: -30,
      grain: 0.25,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Notley Gorge",
    colors: ["#909a85", "#f4efd8", "#f0d59a"],
    backing: "#e3e3cf",
    speed: 1.1,
    params: {
      density: 0.8,
      plantHeight: 0.85,
      sway: 2.5,
      stepFps: 12,
      farTint: 0.3,
      lampAzimuth: 60,
      grain: 0.45,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Liffey Falls",
    colors: ["#9e9587", "#f6ecdf", "#f3cf9e"],
    backing: "#e8dccd",
    speed: 1,
    params: {
      density: 1.1,
      plantHeight: 1,
      sway: 3,
      stepFps: 6,
      farTint: 0.55,
      lampAzimuth: 20,
      grain: 0.3,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Hollybank",
    colors: ["#9595a8", "#f1f0f2", "#ead8b0"],
    backing: "#dcdbe6",
    speed: 0.8,
    params: {
      density: 0.6,
      plantHeight: 1.3,
      sway: 1.2,
      stepFps: 15,
      farTint: 0.25,
      lampAzimuth: -50,
      grain: 0.5,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Tarkine",
    colors: ["#0e0c15", "#6b5236", "#ba884e"],
    backing: "#36293b",
    speed: 1,
    params: {
      density: 1,
      plantHeight: 1,
      sway: 2,
      stepFps: 10,
      farTint: 0.4,
      lampAzimuth: 36,
      grain: 0.35,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Styx Valley",
    colors: ["#0b1210", "#4d5a3c", "#a68e53"],
    backing: "#1f2a24",
    speed: 0.9,
    params: {
      density: 1.3,
      plantHeight: 1.2,
      sway: 1.6,
      stepFps: 8,
      farTint: 0.5,
      lampAzimuth: -28,
      grain: 0.3,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Florentine",
    colors: ["#100c10", "#5e3f3a", "#c08566"],
    backing: "#2e1f28",
    speed: 1.1,
    params: {
      density: 0.8,
      plantHeight: 0.9,
      sway: 2.6,
      stepFps: 12,
      farTint: 0.3,
      lampAzimuth: 55,
      grain: 0.45,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Weld Valley",
    colors: ["#0a0e16", "#3d4f63", "#8d8e9c"],
    backing: "#1b2233",
    speed: 1,
    params: {
      density: 1.1,
      plantHeight: 1,
      sway: 2,
      stepFps: 10,
      farTint: 0.45,
      lampAzimuth: -40,
      grain: 0.4,
    },
  }),
];
