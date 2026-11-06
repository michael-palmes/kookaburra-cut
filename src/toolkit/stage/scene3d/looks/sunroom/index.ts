import { goboCompanionSun } from "../../kit/gobo";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { Sunroom } from "./Sunroom";

/** Sunroom (atmosphere): a plaster room in late light, a low side sun falling through a venetian blind as soft slatted bars across the wall and floor, drifting as the sun swings. */
export const look: Scene3dBackgroundDef = {
  id: "sunroom",
  name: "Sunroom",
  family: "atmosphere",
  colorSlots: [
    { label: "Plaster", fallback: "#2b221c" },
    { label: "Sunlight", fallback: "#795b3e" },
    { label: "Floor", fallback: "#1f1914" },
  ],
  params: {
    sunSide: { label: "Sun side", default: -30, min: -70, max: 70, step: 1 },
    sunHeight: { label: "Sun height", default: 24, min: 14, max: 50, step: 1 },
    drift: { label: "Drift", default: 2, min: 0, max: 8, step: 0.1 },
    patch: { label: "Light patch", default: -0.25, min: -1, max: 1, step: 0.01 },
    slatPitch: { label: "Slat pitch", default: 0.68, min: 0.25, max: 0.9, step: 0.01 },
    opening: { label: "Slat opening", default: 0.66, min: 0.3, max: 0.85, step: 0.01 },
    panes: { label: "Window panes", default: 3, min: 1, max: 4, step: 1 },
    softness: { label: "Softness", default: 1.3, min: 0.3, max: 3, step: 0.05 },
    wallDistance: { label: "Wall distance", default: 9, min: 7, max: 14, step: 0.5 },
  },
  Component: Sunroom,
};

/** Matching rig: a warm low key from the blind's side at the sun's mean bearing and height (static, so the drift is left out), over a soft interior. */
function companion(
  mode: "light" | "dark",
  sunSide: number,
  sunHeight: number,
  kelvin: number,
): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:interior", intensity: dark ? 0.3 : 0.65, rotationDeg: 0 },
    sun: goboCompanionSun(
      { azimuthDeg: sunSide, elevationDeg: sunHeight },
      { intensity: dark ? 2 : 2.2, kelvin, angularDeg: 1.5 },
    ),
    ambient: dark ? 0.2 : 0.45,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting" | "params"> & {
  params: Record<string, number>;
  kelvin: number;
};

const preset = (mode: "light" | "dark", { kelvin, ...p }: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: companion(mode, p.params.sunSide, p.params.sunHeight, kelvin),
});

/** Northern Rivers names, coast and hinterland. p1 is the Daylight Studio world. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Bangalow",
    colors: ["#d0bfb5", "#fff4ea", "#c9b7ab"],
    backing: "#efe6de",
    speed: 1,
    kelvin: 3800,
    params: {
      sunSide: -22,
      sunHeight: 24,
      drift: 2,
      patch: -0.25,
      slatPitch: 0.68,
      opening: 0.66,
      panes: 3,
      softness: 1.3,
      wallDistance: 9,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Newrybar",
    colors: ["#b9bcc0", "#f6f6f1", "#b3b2ad"],
    backing: "#e3e5e6",
    speed: 1,
    kelvin: 5200,
    params: {
      sunSide: 45,
      sunHeight: 32,
      drift: 2,
      patch: 0.35,
      slatPitch: 0.45,
      opening: 0.55,
      panes: 2,
      softness: 1,
      wallDistance: 10,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Tintenbar",
    colors: ["#b4bba6", "#f5f2e2", "#b8b09c"],
    backing: "#e3e5d9",
    speed: 1.1,
    kelvin: 4400,
    params: {
      sunSide: -55,
      sunHeight: 20,
      drift: 3,
      patch: -0.2,
      slatPitch: 0.66,
      opening: 0.68,
      panes: 4,
      softness: 1.7,
      wallDistance: 8,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Lennox Head",
    colors: ["#d1ad9f", "#fde9dc", "#c9a594"],
    backing: "#f0dcd2",
    speed: 0.9,
    kelvin: 3400,
    params: {
      sunSide: 30,
      sunHeight: 38,
      drift: 2,
      patch: 0.1,
      slatPitch: 0.48,
      opening: 0.5,
      panes: 1,
      softness: 1.1,
      wallDistance: 11,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Brunswick Heads",
    colors: ["#cdbb98", "#fdf3d8", "#c2ae8c"],
    backing: "#ece2cc",
    speed: 1,
    kelvin: 4000,
    params: {
      sunSide: -25,
      sunHeight: 30,
      drift: 2.5,
      patch: 0.25,
      slatPitch: 0.6,
      opening: 0.62,
      panes: 3,
      softness: 1.4,
      wallDistance: 12,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Nightcap",
    colors: ["#2b221c", "#795b3e", "#1f1914"],
    backing: "#130f0c",
    speed: 1,
    kelvin: 2900,
    params: {
      sunSide: -40,
      sunHeight: 22,
      drift: 2.5,
      patch: -0.35,
      slatPitch: 0.55,
      opening: 0.55,
      panes: 3,
      softness: 1.3,
      wallDistance: 9,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Border Ranges",
    colors: ["#161b26", "#566279", "#121621"],
    backing: "#0a0d14",
    speed: 0.9,
    kelvin: 7500,
    params: {
      sunSide: 50,
      sunHeight: 34,
      drift: 1.5,
      patch: 0.3,
      slatPitch: 0.48,
      opening: 0.45,
      panes: 2,
      softness: 0.9,
      wallDistance: 10,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Minyon",
    colors: ["#261a20", "#7a5464", "#1d1418"],
    backing: "#110b0e",
    speed: 1.1,
    kelvin: 3100,
    params: {
      sunSide: -60,
      sunHeight: 18,
      drift: 3,
      patch: -0.1,
      slatPitch: 0.64,
      opening: 0.62,
      panes: 4,
      softness: 1.8,
      wallDistance: 8,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Terania",
    colors: ["#18201b", "#55684f", "#141a15"],
    backing: "#0b100c",
    speed: 1,
    kelvin: 3600,
    params: {
      sunSide: 25,
      sunHeight: 28,
      drift: 2,
      patch: 0.2,
      slatPitch: 0.58,
      opening: 0.58,
      panes: 1,
      softness: 1.5,
      wallDistance: 12,
    },
  }),
];
