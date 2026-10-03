import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { ClerestoryShafts } from "./ClerestoryShafts";
import { CLERESTORY } from "./shafts";

/** Clerestory shafts (atmosphere): cathedral god rays and Turrell light rooms, parallel sun shafts from high glowing roof slots faked as soft marched volumes, landing as analytic pools (F6). */
export const look: Scene3dBackgroundDef = {
  id: "clerestory-shafts",
  name: "Clerestory shafts",
  family: "atmosphere",
  colorSlots: [
    { label: "Beam", fallback: "#715f3d" },
    { label: "Air", fallback: "#3a2f23" },
    { label: "Floor", fallback: "#1b1512" },
    { label: "Slot", fallback: "#a88b58", glow: true },
  ],
  params: {
    shaftCount: { label: "Shafts", default: 8, min: 3, max: CLERESTORY.maxShafts, step: 1 },
    tilt: { label: "Sun lean", default: 28, min: 10, max: 40, step: 1 },
    sweep: { label: "Sweep", default: 8, min: 0, max: 15, step: 0.5 },
    haze: { label: "Haze", default: 0.6, min: 0.2, max: 1, step: 0.01 },
    dust: { label: "Dust", default: 0.5, min: 0, max: 1, step: 0.01 },
    poolSoftness: { label: "Pool softness", default: 0.45, min: 0.1, max: 1.2, step: 0.01 },
  },
  Component: ClerestoryShafts,
};

/** The companion sun sits up the shafts: opposite the azimuth the light travels toward, leaning off vertical by the preset's own sun lean. */
export function clerestorySunAzimuth(): number {
  return CLERESTORY.azimuthDeg - 180;
}

/** Matching rig: a low warm key up the shaft direction (the sweep's mean) over a dim interior, so devices catch the light the shafts carry. */
function companion(
  mode: "light" | "dark",
  tiltDeg: number,
  kelvin: number,
  intensity: number,
): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:interior", intensity: dark ? 0.3 : 0.6, rotationDeg: 0 },
    sun: {
      azimuthDeg: clerestorySunAzimuth(),
      elevationDeg: 90 - tiltDeg,
      intensity,
      kelvin,
      angularDeg: 3,
    },
    ambient: dark ? 0.15 : 0.4,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting"> & {
  params: Record<string, number>;
};

const preset = (
  mode: "light" | "dark",
  light: { kelvin: number; intensity: number },
  p: Tune,
): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: companion(mode, p.params.tilt, light.kelvin, light.intensity),
});

/** Queensland rainforest and cave names. p1 and p6 are the approved sketch palettes (p1's floor lifted to the 0.315 Theme floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset(
    "light",
    { kelvin: 4200, intensity: 1.6 },
    {
      id: "p1",
      name: "Lamington",
      colors: ["#f7f4ef", "#d3c8bb", "#a89688", "#fbf8f2"],
      backing: "#bcb0a3",
      speed: 1,
      params: {
        shaftCount: 8,
        tilt: 28,
        sweep: 8,
        haze: 0.6,
        dust: 0.5,
        poolSoftness: 0.45,
      },
    },
  ),
  preset(
    "light",
    { kelvin: 5200, intensity: 1.4 },
    {
      id: "p2",
      name: "Springbrook",
      colors: ["#f2f5ee", "#cdd3c6", "#949f8f", "#f8faf4"],
      backing: "#b5bdaf",
      speed: 0.9,
      params: {
        shaftCount: 10,
        tilt: 22,
        sweep: 6,
        haze: 0.75,
        dust: 0.35,
        poolSoftness: 0.7,
      },
    },
  ),
  preset(
    "light",
    { kelvin: 3600, intensity: 1.8 },
    {
      id: "p3",
      name: "Binna Burra",
      colors: ["#f8f1e2", "#dccdb0", "#a79574", "#fcf6e8"],
      backing: "#c4b79c",
      speed: 1.1,
      params: {
        shaftCount: 6,
        tilt: 34,
        sweep: 10,
        haze: 0.5,
        dust: 0.7,
        poolSoftness: 0.3,
      },
    },
  ),
  preset(
    "light",
    { kelvin: 6000, intensity: 1.4 },
    {
      id: "p4",
      name: "Kondalilla",
      colors: ["#eef2f6", "#c6cfd8", "#8f9caa", "#f6f8fb"],
      backing: "#aeb9c4",
      speed: 0.85,
      params: {
        shaftCount: 9,
        tilt: 18,
        sweep: 5,
        haze: 0.55,
        dust: 0.4,
        poolSoftness: 0.6,
      },
    },
  ),
  preset(
    "light",
    { kelvin: 3800, intensity: 1.5 },
    {
      id: "p5",
      name: "Eungella",
      colors: ["#f7eff0", "#d8c7ca", "#a8939a", "#fbf5f6"],
      backing: "#c0afb3",
      speed: 1,
      params: {
        shaftCount: 7,
        tilt: 30,
        sweep: 12,
        haze: 0.65,
        dust: 0.55,
        poolSoftness: 0.9,
      },
    },
  ),
  preset(
    "dark",
    { kelvin: 3400, intensity: 1.6 },
    {
      id: "p6",
      name: "Chillagoe",
      colors: ["#715f3d", "#3a2f23", "#1b1512", "#a88b58"],
      backing: "#251f18",
      speed: 1,
      params: {
        shaftCount: 8,
        tilt: 28,
        sweep: 8,
        haze: 0.6,
        dust: 0.5,
        poolSoftness: 0.45,
      },
    },
  ),
  preset(
    "dark",
    { kelvin: 5600, intensity: 1.3 },
    {
      id: "p7",
      name: "Royal Arch",
      colors: ["#52647a", "#283340", "#11161c", "#7e93a6"],
      backing: "#1a2129",
      speed: 0.9,
      params: {
        shaftCount: 5,
        tilt: 24,
        sweep: 6,
        haze: 0.8,
        dust: 0.3,
        poolSoftness: 0.35,
      },
    },
  ),
  preset(
    "dark",
    { kelvin: 4400, intensity: 1.4 },
    {
      id: "p8",
      name: "Capricorn Caves",
      colors: ["#5a6649", "#2c3326", "#121611", "#8e9463"],
      backing: "#1a1f17",
      speed: 1.1,
      params: {
        shaftCount: 10,
        tilt: 32,
        sweep: 10,
        haze: 0.5,
        dust: 0.65,
        poolSoftness: 0.6,
      },
    },
  ),
  preset(
    "dark",
    { kelvin: 6400, intensity: 1.2 },
    {
      id: "p9",
      name: "Natural Bridge",
      colors: ["#4b6670", "#24323a", "#0e1418", "#74959b"],
      backing: "#141c21",
      speed: 0.8,
      params: {
        shaftCount: 6,
        tilt: 14,
        sweep: 4,
        haze: 0.6,
        dust: 0.8,
        poolSoftness: 0.8,
      },
    },
  ),
];
