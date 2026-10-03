import { stageSpot } from "../../kit";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { BLOOMS } from "./blooms";
import { ShylightBlooms } from "./ShylightBlooms";

export const look: Scene3dBackgroundDef = {
  id: "shylight-blooms",
  name: "Shylight blooms",
  family: "kinetic",
  colorSlots: [
    { label: "Petal", fallback: "#615b70" },
    { label: "Fold", fallback: "#221f2c" },
    { label: "Core", fallback: "#b28c58", glow: true },
    { label: "Cable", fallback: "#4a4656" },
  ],
  params: {
    count: { label: "Blooms", default: 18, min: 12, max: BLOOMS.max, step: 1 },
    radius: { label: "Ring radius", default: 12, min: 10, max: 15, step: 0.5 },
    openHeight: { label: "Open height", default: 4.8, min: 4.2, max: 5.8, step: 0.1 },
    drop: { label: "Drop", default: 3.4, min: 2, max: 5, step: 0.1 },
    size: { label: "Bloom size", default: 1.1, min: 0.7, max: 1.3, step: 0.05 },
    cycle: { label: "Cycle (s)", default: 80, min: 40, max: 180, step: 5 },
    cables: { label: "Cable opacity", default: 0.85, min: 0, max: 1, step: 0.05 },
    pools: { label: "Floor pools", default: 0.2, min: 0, max: 0.4, step: 0.01 },
  },
  previewCamera: "ceiling",
  Component: ShylightBlooms,
};

/** Matching rig: a warm top light and a faint spot in the Core colour, both from above the front of the stage where blooms hang over the camera, so a device takes the glow on its face rather than as a rim from behind. No core fixtures: they would draw unfaded across the stage on a dolly out (F11). */
function bloomLighting(mode: "light" | "dark", core: string): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: {
      source: dark ? "kookaburra:night-city" : "kookaburra:ferndale-studio",
      intensity: dark ? 0.35 : 0.85,
      rotationDeg: 0,
    },
    sun: { azimuthDeg: 20, elevationDeg: 65, intensity: dark ? 1.2 : 1.8, kelvin: 3200 },
    ambient: dark ? 0.12 : 0.35,
    lights: [
      stageSpot("bg3d-shylight-glow", {
        azimuthDeg: -35,
        elevationDeg: 45,
        distance: 12,
        irradiance: dark ? 0.4 : 0.3,
        coneDeg: 40,
        color: core,
      }),
    ],
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: bloomLighting(mode, p.colors[2]),
});

export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Lizard Island",
    colors: ["#f3ebe4", "#b3a9a6", "#eecb92", "#979ca0"],
    backing: "#f7f4f1",
    speed: 1,
    params: {
      count: 18,
      radius: 12,
      openHeight: 4.8,
      drop: 3.4,
      size: 1.1,
      cycle: 80,
      cables: 0.85,
      pools: 0.24,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Michaelmas Cay",
    colors: ["#f4e6e1", "#bca39c", "#eeb9a0", "#a39a98"],
    backing: "#f9f3f1",
    speed: 1,
    params: {
      count: 22,
      radius: 13,
      openHeight: 5,
      drop: 3.8,
      size: 0.9,
      cycle: 70,
      cables: 0.7,
      pools: 0.26,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Low Isles",
    colors: ["#e6efea", "#a4b3ac", "#d9d3a0", "#929e9b"],
    backing: "#f3f7f5",
    speed: 0.9,
    params: {
      count: 12,
      radius: 11,
      openHeight: 4.6,
      drop: 2.6,
      size: 1.25,
      cycle: 100,
      cables: 0.9,
      pools: 0.18,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Lady Musgrave",
    colors: ["#ebe8f2", "#aeaabd", "#e4c3a6", "#9c9cad"],
    backing: "#f5f4f9",
    speed: 1.1,
    params: {
      count: 24,
      radius: 14.5,
      openHeight: 5.1,
      drop: 4.2,
      size: 0.85,
      cycle: 60,
      cables: 0.6,
      pools: 0.2,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Wistari Reef",
    colors: ["#f6ebdc", "#c2ab94", "#f0c487", "#a49c92"],
    backing: "#faf5ee",
    speed: 0.8,
    params: {
      count: 16,
      radius: 11.5,
      openHeight: 4.7,
      drop: 4.6,
      size: 1.15,
      cycle: 120,
      cables: 0.8,
      pools: 0.3,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Osprey Reef",
    colors: ["#615b70", "#221f2c", "#b28c58", "#4a4656"],
    backing: "#100e16",
    speed: 1,
    params: {
      count: 18,
      radius: 12,
      openHeight: 4.8,
      drop: 3.4,
      size: 1.1,
      cycle: 80,
      cables: 0.85,
      pools: 0.2,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Flinders Reef",
    colors: ["#4b6266", "#172427", "#a98f58", "#3a4a4d"],
    backing: "#0b1112",
    speed: 0.9,
    params: {
      count: 20,
      radius: 13.5,
      openHeight: 4.9,
      drop: 3.8,
      size: 0.95,
      cycle: 90,
      cables: 0.75,
      pools: 0.18,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Holmes Reef",
    colors: ["#5d5875", "#1e1c2e", "#b5876d", "#45425a"],
    backing: "#0d0c16",
    speed: 1.1,
    params: {
      count: 14,
      radius: 11,
      openHeight: 4.6,
      drop: 2.8,
      size: 1.2,
      cycle: 65,
      cables: 0.9,
      pools: 0.24,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Bougainville Reef",
    colors: ["#55604f", "#1b2119", "#9c9160", "#414a3e"],
    backing: "#0c0f0b",
    speed: 0.8,
    params: {
      count: 22,
      radius: 12.5,
      openHeight: 5,
      drop: 4.8,
      size: 1,
      cycle: 140,
      cables: 0.7,
      pools: 0.14,
    },
  }),
];
