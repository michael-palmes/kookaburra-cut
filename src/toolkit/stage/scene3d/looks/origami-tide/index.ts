import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { OrigamiTide } from "./OrigamiTide";
import { ORIGAMI } from "./origami";

/** Origami tide (kinetic): Miura-ori rigid folding, the Al Bahr Towers' origami shading units and Nils Völker's breathing installations. */
export const look: Scene3dBackgroundDef = {
  id: "origami-tide",
  name: "Origami tide",
  family: "kinetic",
  colorSlots: [
    { label: "Paper", fallback: "#4e565f" },
    { label: "Crease shade", fallback: "#20262d" },
  ],
  params: {
    radius: { label: "Radius", default: 13, min: 10, max: 20, step: 0.5 },
    top: { label: "Wall top", default: 6.8, min: 3, max: 12, step: 0.1 },
    fold: { label: "Tide depth", default: 0.8, min: 0, max: 1, step: 0.01 },
    pleat: { label: "Pleat size", default: 0.85, min: 0.5, max: 1.4, step: 0.05 },
    period: { label: "Loop length (s)", default: 120, min: 60, max: 360, step: 5 },
    sway: { label: "Sun sway (deg)", default: 30, min: 0, max: 90, step: 1 },
  },
  Component: OrigamiTide,
};

/** Matching rig: a soft raking key from the +x side at the virtual sun's mean seat, over a quiet environment. */
export function origamiLighting(mode: "light" | "dark"): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: {
      source: dark ? "kookaburra:interior" : "kookaburra:softbox",
      intensity: dark ? 0.3 : 0.65,
      rotationDeg: 0,
    },
    sun: {
      azimuthDeg: ORIGAMI.sunAzimuthDeg,
      elevationDeg: ORIGAMI.sunElevationDeg,
      intensity: dark ? 1.3 : 1.7,
      kelvin: 5200,
    },
    ambient: dark ? 0.15 : 0.35,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: origamiLighting(mode),
});

/** Inland lakes and salt lakes. p1 and p6 carry the approved sketch palettes. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Lake Gairdner",
    colors: ["#e9e4da", "#a0988a"],
    backing: "#f5f3ee",
    speed: 1,
    params: { radius: 13, top: 6.8, fold: 0.8, pleat: 0.85, period: 120, sway: 30 },
  }),
  preset("light", {
    id: "p2",
    name: "Lake Callabonna",
    colors: ["#dfe2e2", "#909ca0"],
    backing: "#f3f5f5",
    speed: 0.9,
    params: { radius: 14, top: 6, fold: 0.65, pleat: 1, period: 150, sway: 20 },
  }),
  preset("light", {
    id: "p3",
    name: "Lake Bumbunga",
    colors: ["#ecdcd8", "#b0928d"],
    backing: "#f8f1ef",
    speed: 1,
    params: {
      radius: 12.5,
      top: 7.5,
      fold: 0.9,
      pleat: 0.7,
      period: 100,
      sway: 40,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Lake Menindee",
    colors: ["#dde0d0", "#959b85"],
    backing: "#f4f5ee",
    speed: 0.8,
    params: { radius: 15, top: 8.5, fold: 0.7, pleat: 1.15, period: 180, sway: 25 },
  }),
  preset("light", {
    id: "p5",
    name: "Lake Amadeus",
    colors: ["#ecdcc4", "#b49674"],
    backing: "#f8f2e8",
    speed: 1.1,
    params: {
      radius: 13.5,
      top: 5.5,
      fold: 0.85,
      pleat: 0.95,
      period: 90,
      sway: 45,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Lake Mungo",
    colors: ["#4e565f", "#20262d"],
    backing: "#0c0f12",
    speed: 1,
    params: { radius: 13, top: 6.8, fold: 0.8, pleat: 0.85, period: 120, sway: 30 },
  }),
  preset("dark", {
    id: "p7",
    name: "Lake Frome",
    colors: ["#5a5048", "#251f1c"],
    backing: "#0f0c0b",
    speed: 0.9,
    params: { radius: 14, top: 7.2, fold: 0.75, pleat: 1.05, period: 140, sway: 35 },
  }),
  preset("dark", {
    id: "p8",
    name: "Lake Lefroy",
    colors: ["#4a5552", "#1c2321"],
    backing: "#0b0e0d",
    speed: 1.1,
    params: {
      radius: 12.5,
      top: 6.2,
      fold: 0.9,
      pleat: 0.75,
      period: 100,
      sway: 20,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Lake Mackay",
    colors: ["#575068", "#221f2b"],
    backing: "#0e0d13",
    speed: 0.8,
    params: { radius: 16, top: 9, fold: 0.7, pleat: 1.2, period: 200, sway: 50 },
  }),
];
