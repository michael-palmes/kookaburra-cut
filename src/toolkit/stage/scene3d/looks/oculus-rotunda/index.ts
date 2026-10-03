import { goboCompanionSun } from "../../kit/gobo";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { OculusRotunda } from "./OculusRotunda";
import { cappedMaxElevation, ELEVATION_SWING } from "./rotunda";

/** Oculus rotunda (deco): the Pantheon's coffered dome over a pilastered drum, one oculus casting a soft sun disc that swings across the back of the drum like a sundial. */
export const look: Scene3dBackgroundDef = {
  id: "oculus-rotunda",
  name: "Oculus rotunda",
  family: "deco",
  colorSlots: [
    { label: "Stone", fallback: "#4e535c" },
    { label: "Coffer shadow", fallback: "#14181e" },
    { label: "Sun disc", fallback: "#8a7048", glow: true },
  ],
  params: {
    radius: { label: "Drum radius", default: 22, min: 16, max: 30, step: 0.5 },
    coffers: { label: "Coffers per ring", default: 28, min: 16, max: 36, step: 1 },
    discSize: { label: "Disc size", default: 3, min: 1.5, max: 5, step: 0.1 },
    traverse: { label: "Traverse (s)", default: 90, min: 45, max: 180, step: 1 },
    maxElevation: { label: "Max elevation", default: 52, min: 35, max: 58, step: 1 },
    studs: { label: "Studs", default: 0, min: 0, max: 1, step: 0.01 },
  },
  Component: OculusRotunda,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting"> & {
  params: Record<string, number>;
};

/** Matching rig: a soft warm sun from the oculus side at the beam's mean (the disc's path is keyframe-free, so the sway is left out), a low interior environment and ambient, so devices share the oculus light. */
function rotundaLighting(mode: "light" | "dark", params: Record<string, number>, kelvin: number) {
  const dark = mode === "dark";
  const top = cappedMaxElevation(params.radius, params.discSize, params.maxElevation);
  const lighting: Scene3dCompanionLighting = {
    environment: {
      source: dark ? "kookaburra:warehouse" : "kookaburra:monochrome-studio",
      intensity: dark ? 0.3 : 0.6,
      rotationDeg: 0,
    },
    sun: goboCompanionSun(
      { azimuthDeg: 0, elevationDeg: Math.round(top - ELEVATION_SWING / 2) },
      { intensity: dark ? 1.2 : 1.5, kelvin, angularDeg: 3 },
    ),
    ambient: dark ? 0.25 : 0.45,
  };
  return lighting;
}

const preset = (mode: "light" | "dark", kelvin: number, p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: rotundaLighting(mode, p.params, kelvin),
});

/** Kimberley and Pilbara gorge names (Leeuwin kept from the approved sketch). p1 and p6 are the sketch palettes, p1's shade lifted to the Theme tile floor. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", 4800, {
    id: "p1",
    name: "Leeuwin",
    colors: ["#e4ddd0", "#a1988b", "#fff1d2"],
    backing: "#f4efe6",
    speed: 1,
    params: {
      radius: 22,
      coffers: 28,
      discSize: 3,
      traverse: 90,
      maxElevation: 52,
      studs: 0,
    },
  }),
  preset("light", 4400, {
    id: "p2",
    name: "Dales Gorge",
    colors: ["#e6d6cc", "#aa9387", "#fff0dc"],
    backing: "#f6eee8",
    speed: 1.1,
    params: {
      radius: 20,
      coffers: 24,
      discSize: 3.5,
      traverse: 75,
      maxElevation: 50,
      studs: 0,
    },
  }),
  preset("light", 5200, {
    id: "p3",
    name: "Hamersley Gorge",
    colors: ["#dcd8dc", "#9c96a0", "#fbefd8"],
    backing: "#f3f1f3",
    speed: 0.9,
    params: {
      radius: 25,
      coffers: 32,
      discSize: 2.6,
      traverse: 120,
      maxElevation: 54,
      studs: 0,
    },
  }),
  preset("light", 5000, {
    id: "p4",
    name: "Fern Pool",
    colors: ["#dde0d6", "#96a092", "#f8f2d6"],
    backing: "#f2f4ee",
    speed: 1.2,
    params: {
      radius: 18,
      coffers: 20,
      discSize: 3.2,
      traverse: 60,
      maxElevation: 48,
      studs: 0,
    },
  }),
  preset("light", 4200, {
    id: "p5",
    name: "Kalamina",
    colors: ["#e8dcc6", "#a89878", "#fff3d6"],
    backing: "#f7f1e6",
    speed: 0.8,
    params: {
      radius: 28,
      coffers: 36,
      discSize: 4,
      traverse: 150,
      maxElevation: 56,
      studs: 0,
    },
  }),
  preset("dark", 4000, {
    id: "p6",
    name: "Tunnel Creek",
    colors: ["#4e535c", "#14181e", "#8a7048"],
    backing: "#07090c",
    speed: 1,
    params: {
      radius: 22,
      coffers: 28,
      discSize: 3,
      traverse: 90,
      maxElevation: 52,
      studs: 1,
    },
  }),
  preset("dark", 4200, {
    id: "p7",
    name: "Bell Gorge",
    colors: ["#3e4a4c", "#101618", "#86744e"],
    backing: "#060a0b",
    speed: 1.1,
    params: {
      radius: 20,
      coffers: 24,
      discSize: 3.4,
      traverse: 70,
      maxElevation: 50,
      studs: 0.8,
    },
  }),
  preset("dark", 3600, {
    id: "p8",
    name: "Geikie Gorge",
    colors: ["#4f463f", "#17120f", "#937048"],
    backing: "#0a0807",
    speed: 0.9,
    params: {
      radius: 26,
      coffers: 32,
      discSize: 2.8,
      traverse: 120,
      maxElevation: 55,
      studs: 1,
    },
  }),
  preset("dark", 4400, {
    id: "p9",
    name: "Python Pool",
    colors: ["#4a4756", "#121019", "#8c7458"],
    backing: "#08070c",
    speed: 1.2,
    params: {
      radius: 17,
      coffers: 20,
      discSize: 4,
      traverse: 50,
      maxElevation: 46,
      studs: 0.6,
    },
  }),
];
