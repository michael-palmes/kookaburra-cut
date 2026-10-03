import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { HiroshigeRain } from "./HiroshigeRain";
import { RAIN_DENSITY_MAX, RAIN_PUDDLES_MAX } from "./rain";

export const look: Scene3dBackgroundDef = {
  id: "hiroshige-rain",
  name: "Hiroshige rain",
  family: "lines",
  colorSlots: [
    { label: "Near rain", fallback: "#56616c" },
    { label: "Far rain", fallback: "#3c464f" },
    { label: "Puddle", fallback: "#4b5963" },
  ],
  params: {
    density: { label: "Density", default: 1, min: 0.3, max: RAIN_DENSITY_MAX, step: 0.05 },
    fall: { label: "Fall speed", default: 1, min: 0.3, max: 2, step: 0.05 },
    nearSlant: { label: "Near slant", default: -7, min: -20, max: 20, step: 0.5 },
    farSlant: { label: "Far slant", default: 12, min: -25, max: 25, step: 0.5 },
    puddles: { label: "Puddle rings", default: 1, min: 0, max: RAIN_PUDDLES_MAX, step: 0.05 },
    horizon: { label: "Horizon line", default: 1, min: 0, max: 1, step: 0.01 },
  },
  Component: HiroshigeRain,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
});

/** Gippsland names. p1 and p6 are the approved sketch palettes. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Corner Inlet",
    colors: ["#8f9aa6", "#b5bec7", "#a3b0b9"],
    backing: "#f2f4f5",
    speed: 1,
    params: {
      density: 1,
      fall: 1,
      nearSlant: -7,
      farSlant: 12,
      puddles: 1,
      horizon: 1,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Lake Tyers",
    colors: ["#8e9a8f", "#b3bdb2", "#a2ae9f"],
    backing: "#f3f4ef",
    speed: 1,
    params: {
      density: 0.8,
      fall: 0.8,
      nearSlant: -5,
      farSlant: 9,
      puddles: 0.7,
      horizon: 1,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Raymond Island",
    colors: ["#9a97a6", "#bdbac7", "#aeaaba"],
    backing: "#f5f4f7",
    speed: 1,
    params: {
      density: 1.25,
      fall: 0.9,
      nearSlant: 8,
      farSlant: -14,
      puddles: 1.3,
      horizon: 0.7,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Seaspray",
    colors: ["#a0998c", "#c2bcb0", "#b2ab9d"],
    backing: "#f6f3ec",
    speed: 1,
    params: {
      density: 0.75,
      fall: 1.3,
      nearSlant: -12,
      farSlant: 18,
      puddles: 0.5,
      horizon: 0.8,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Venus Bay",
    colors: ["#8a9ea4", "#afc2c6", "#9cb2b6"],
    backing: "#eff5f5",
    speed: 1,
    params: {
      density: 1.4,
      fall: 0.6,
      nearSlant: -3,
      farSlant: 6,
      puddles: 1.6,
      horizon: 1,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Tarra Bulga",
    colors: ["#56616c", "#3c464f", "#4b5963"],
    backing: "#0e1216",
    speed: 1,
    params: {
      density: 1,
      fall: 1,
      nearSlant: -7,
      farSlant: 12,
      puddles: 1,
      horizon: 1,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Errinundra",
    colors: ["#536258", "#3b4840", "#4a5a4f"],
    backing: "#0d120f",
    speed: 1,
    params: {
      density: 1.3,
      fall: 0.8,
      nearSlant: -9,
      farSlant: 14,
      puddles: 0.8,
      horizon: 0.6,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Noojee",
    colors: ["#665b50", "#4a4038", "#5a5046"],
    backing: "#120f0c",
    speed: 1,
    params: {
      density: 0.7,
      fall: 1.1,
      nearSlant: 6,
      farSlant: -10,
      puddles: 1.4,
      horizon: 1,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Walhalla",
    colors: ["#5a5a72", "#3f3f55", "#4e4e66"],
    backing: "#0f0f16",
    speed: 1,
    params: {
      density: 1.1,
      fall: 0.7,
      nearSlant: -4,
      farSlant: 16,
      puddles: 0.6,
      horizon: 0.8,
    },
  }),
];
