import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { GROVE } from "./grove";
import { WindWands } from "./WindWands";

/** Wind wands (kinetic): Len Lye's swaying kinetic rods planted as a grove round the stage, lantern beads at their tips. */
export const look: Scene3dBackgroundDef = {
  id: "wind-wands",
  name: "Wind wands",
  family: "kinetic",
  colorSlots: [
    { label: "Wand", fallback: "#6a524a" },
    { label: "Lantern", fallback: "#b8844f", glow: true },
    { label: "Ground", fallback: "#1c1715" },
  ],
  params: {
    count: { label: "Wands", default: 84, min: 30, max: GROVE.maxWands, step: 1 },
    inner: { label: "First row", default: 18, min: 12, max: 30, step: 0.5 },
    height: { label: "Height", default: 1, min: 0.6, max: 1.6, step: 0.05 },
    lean: { label: "Lean", default: 0.1, min: 0, max: 0.2, step: 0.005 },
    sway: { label: "Sway", default: 0.065, min: 0, max: 0.12, step: 0.005 },
    gust: { label: "Gust every (s)", default: 12, min: 6, max: 40, step: 1 },
    haze: { label: "Haze (deg)", default: 10, min: 4, max: 16, step: 0.5 },
  },
  Component: WindWands,
};

/** Downwind azimuth (v9 orbit convention, 0 = +z) of the mean wind. */
export const DOWNWIND_AZIMUTH_DEG = Math.round(
  (Math.atan2(Math.cos(GROVE.windMean), Math.sin(GROVE.windMean)) * 180) / Math.PI,
);

/** Matching rig: a low warm key from the downwind side, as if the sun were setting behind the grove on a foreshore at dusk (companion blocks are static, so the mean wind). */
function duskKey(mode: "light" | "dark"): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:sunset", intensity: dark ? 0.35 : 0.7, rotationDeg: 0 },
    sun: {
      azimuthDeg: DOWNWIND_AZIMUTH_DEG,
      elevationDeg: 20,
      intensity: dark ? 1.4 : 2,
      kelvin: dark ? 2600 : 3400,
    },
    ambient: dark ? 0.12 : 0.35,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: duskKey(mode),
});

/** Central Australian stations, creeks and springs, several on the Finke. p1 and p6 are the approved sketch palettes (p1's wand lifted to the 0.315 Theme floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Charlotte Waters",
    colors: ["#b39287", "#d9b98f", "#e6dfd4"],
    backing: "#f6f2eb",
    speed: 1,
    params: {
      count: 84,
      inner: 18,
      height: 1,
      lean: 0.1,
      sway: 0.065,
      gust: 12,
      haze: 10,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Ellery Creek",
    colors: ["#9c9a86", "#d6c08f", "#e2e0d2"],
    backing: "#f4f4ee",
    speed: 0.9,
    params: {
      count: 110,
      inner: 16,
      height: 0.85,
      lean: 0.06,
      sway: 0.05,
      gust: 18,
      haze: 9,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Dalhousie Springs",
    colors: ["#879b98", "#d8b48c", "#dfe5e1"],
    backing: "#f2f6f4",
    speed: 1,
    params: {
      count: 70,
      inner: 17,
      height: 1,
      lean: 0.12,
      sway: 0.075,
      gust: 10,
      haze: 9,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Horseshoe Bend",
    colors: ["#bd8f7d", "#dcae86", "#ead9cd"],
    backing: "#f9f1ec",
    speed: 1.1,
    params: {
      count: 96,
      inner: 18,
      height: 1,
      lean: 0.14,
      sway: 0.06,
      gust: 14,
      haze: 9,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Owen Springs",
    colors: ["#a99a6f", "#d9c27f", "#e7e1cb"],
    backing: "#f8f5e9",
    speed: 0.8,
    params: {
      count: 130,
      inner: 22,
      height: 0.9,
      lean: 0.08,
      sway: 0.08,
      gust: 8,
      haze: 10,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Finke",
    colors: ["#6a524a", "#b8844f", "#1c1715"],
    backing: "#0c0a09",
    speed: 1,
    params: {
      count: 84,
      inner: 18,
      height: 1,
      lean: 0.1,
      sway: 0.065,
      gust: 12,
      haze: 10,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Hugh River",
    colors: ["#4e5866", "#a7895a", "#171a1f"],
    backing: "#0b0c0f",
    speed: 0.9,
    params: {
      count: 60,
      inner: 16,
      height: 1.1,
      lean: 0.1,
      sway: 0.07,
      gust: 16,
      haze: 9,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Idracowra",
    colors: ["#6b4a3e", "#b47c53", "#1f1512"],
    backing: "#0e0907",
    speed: 1.1,
    params: {
      count: 120,
      inner: 20,
      height: 0.9,
      lean: 0.13,
      sway: 0.055,
      gust: 10,
      haze: 11,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Ilparpa",
    colors: ["#55604f", "#a08a58", "#161a14"],
    backing: "#0b0d0a",
    speed: 1,
    params: {
      count: 96,
      inner: 24,
      height: 1.1,
      lean: 0.07,
      sway: 0.09,
      gust: 20,
      haze: 10,
    },
  }),
];
