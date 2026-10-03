import { goboCompanionSun } from "../../kit/gobo";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { ColourCourt } from "./ColourCourt";
import { courtSunAzimuth } from "./court";

/** Colour court (art history): Barragan's colour walls in half-light, Ando's light slot and Rothko's soft fields, round the stage. */
export const look: Scene3dBackgroundDef = {
  id: "colour-court",
  name: "Colour court",
  family: "history",
  colorSlots: [
    { label: "Rosa", fallback: "#7a3a4d" },
    { label: "Ochre", fallback: "#6e5429" },
    { label: "Jacaranda", fallback: "#4d4270" },
    { label: "Slot", fallback: "#b08c5a", glow: true },
  ],
  params: {
    layoutSeed: { label: "Layout seed", default: 1, min: 1, max: 12, step: 1 },
    walls: { label: "Walls", default: 8, min: 5, max: 10, step: 1 },
    sunElevation: { label: "Sun elevation", default: 34, min: 15, max: 60, step: 1 },
    sunSwing: { label: "Sun swing", default: 25, min: 0, max: 60, step: 1 },
    dayLength: { label: "Day length (s)", default: 120, min: 60, max: 360, step: 5 },
    fields: { label: "Colour fields", default: 0.35, min: 0, max: 0.7, step: 0.01 },
    blade: { label: "Slot blade", default: 0.34, min: 0, max: 0.6, step: 0.01 },
  },
  previewCamera: "sweep",
  Component: ColourCourt,
};

/** Companion rig: a warm sun at the virtual sun's mean azimuth and the preset's elevation (static, so the swing is left out), so device shadows fall with the painted wall shadows. No light at the slot. */
function courtLighting(
  mode: "light" | "dark",
  seed: number,
  elevationDeg: number,
  kelvin: number,
): Scene3dCompanionLighting {
  const dark = mode === "dark";
  const azimuthDeg = courtSunAzimuth(seed);
  return {
    environment: {
      source: "kookaburra:sunset",
      intensity: dark ? 0.35 : 0.7,
      rotationDeg: azimuthDeg,
    },
    sun: goboCompanionSun(
      { azimuthDeg, elevationDeg },
      { intensity: dark ? 2.2 : 2, kelvin, angularDeg: 2 },
    ),
    ambient: dark ? 0.3 : 0.5,
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
  lighting: courtLighting(mode, p.params.layoutSeed, p.params.sunElevation, kelvin),
});

/** South Australian wine regions and towns (p6 keeps the sketch's Flinders town). p1 and p6 are the approved sketch palettes. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Aldinga",
    colors: ["#e3a0ae", "#e6c48f", "#a391c6", "#f4d6a0"],
    backing: "#faf4ee",
    speed: 1,
    kelvin: 3600,
    params: {
      layoutSeed: 1,
      walls: 8,
      sunElevation: 34,
      sunSwing: 25,
      dayLength: 120,
      fields: 0.35,
      blade: 0.34,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Willunga",
    colors: ["#e6a59b", "#d9c58e", "#8fa2c0", "#f6dcae"],
    backing: "#fbf5ef",
    speed: 1.1,
    kelvin: 4000,
    params: {
      layoutSeed: 4,
      walls: 7,
      sunElevation: 28,
      sunSwing: 30,
      dayLength: 100,
      fields: 0.25,
      blade: 0.3,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Watervale",
    colors: ["#d9a2b8", "#cfcf96", "#8a9eae", "#f0e2a8"],
    backing: "#f7f6ee",
    speed: 0.9,
    kelvin: 4600,
    params: {
      layoutSeed: 7,
      walls: 9,
      sunElevation: 42,
      sunSwing: 20,
      dayLength: 150,
      fields: 0.45,
      blade: 0.25,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Mintaro",
    colors: ["#df9f8f", "#e2bd84", "#a49bb4", "#f6d8a6"],
    backing: "#f9f3ee",
    speed: 1,
    kelvin: 3300,
    params: {
      layoutSeed: 2,
      walls: 6,
      sunElevation: 24,
      sunSwing: 35,
      dayLength: 90,
      fields: 0.3,
      blade: 0.38,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Penwortham",
    colors: ["#e2a6c4", "#efc196", "#9c9dd0", "#f8deb2"],
    backing: "#faf5f3",
    speed: 0.85,
    kelvin: 4200,
    params: {
      layoutSeed: 10,
      walls: 10,
      sunElevation: 38,
      sunSwing: 22,
      dayLength: 180,
      fields: 0.5,
      blade: 0.3,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Parachilna",
    colors: ["#7a3a4d", "#6e5429", "#4d4270", "#b08c5a"],
    backing: "#150f15",
    speed: 1,
    kelvin: 3200,
    params: {
      layoutSeed: 1,
      walls: 8,
      sunElevation: 34,
      sunSwing: 25,
      dayLength: 120,
      fields: 0.35,
      blade: 0.34,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Coonawarra",
    colors: ["#7d3238", "#6a4a2a", "#45405e", "#b4875b"],
    backing: "#140c0d",
    speed: 1.1,
    kelvin: 3000,
    params: {
      layoutSeed: 5,
      walls: 7,
      sunElevation: 26,
      sunSwing: 32,
      dayLength: 96,
      fields: 0.3,
      blade: 0.32,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Sevenhill",
    colors: ["#6b3a55", "#5f5a32", "#3a4a6a", "#a08d5e"],
    backing: "#0e0f14",
    speed: 0.9,
    kelvin: 3800,
    params: {
      layoutSeed: 8,
      walls: 9,
      sunElevation: 40,
      sunSwing: 20,
      dayLength: 160,
      fields: 0.45,
      blade: 0.28,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Wrattonbully",
    colors: ["#73404a", "#5e5a3e", "#3f5560", "#988e66"],
    backing: "#0f1212",
    speed: 1,
    kelvin: 3500,
    params: {
      layoutSeed: 11,
      walls: 6,
      sunElevation: 30,
      sunSwing: 28,
      dayLength: 140,
      fields: 0.25,
      blade: 0.34,
    },
  }),
];
