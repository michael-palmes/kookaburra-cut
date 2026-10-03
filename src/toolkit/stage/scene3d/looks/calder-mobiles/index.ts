import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { CalderMobiles } from "./CalderMobiles";
import { MAX_MOBILES, MIN_MOBILES } from "./mobiles";

export const look: Scene3dBackgroundDef = {
  id: "calder-mobiles",
  name: "Calder mobiles",
  family: "kinetic",
  colorSlots: [
    { label: "Paddle A", fallback: "#5b3a31" },
    { label: "Paddle B", fallback: "#2f4453" },
    { label: "Paddle C", fallback: "#665b37" },
    { label: "Wire", fallback: "#2a2f2d" },
  ],
  params: {
    count: { label: "Mobiles", default: 6, min: MIN_MOBILES, max: MAX_MOBILES, step: 1 },
    swing: { label: "Swing (deg)", default: 35, min: 0, max: 60, step: 1 },
    period: { label: "Loop length (s)", default: 120, min: 60, max: 240, step: 5 },
    paddle: { label: "Paddle size", default: 1, min: 0.6, max: 1.6, step: 0.05 },
    clearance: { label: "Clearance above text", default: 0.45, min: 0.3, max: 0.8, step: 0.01 },
    depth: { label: "Depth", default: 34, min: 20, max: 45, step: 0.5 },
    seed: { label: "Arrangement", default: 1, min: 1, max: 99, step: 1 },
  },
  previewCamera: "ceiling",
  Component: CalderMobiles,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
});

const SKETCH = {
  count: 6,
  swing: 35,
  period: 120,
  paddle: 1,
  clearance: 0.45,
  depth: 34,
  seed: 1,
};

export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Kangaroo Paw",
    colors: ["#d69c84", "#94abbc", "#d6c07f", "#929b94"],
    backing: "#f6f2ea",
    speed: 1,
    params: SKETCH,
  }),
  preset("light", {
    id: "p2",
    name: "Blue Leschenaultia",
    colors: ["#8fa7c4", "#a9b9a0", "#d8c9a6", "#949ca4"],
    backing: "#f4f5f2",
    speed: 0.9,
    params: {
      count: 5,
      swing: 28,
      period: 150,
      paddle: 1.15,
      clearance: 0.5,
      depth: 38,
      seed: 7,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Pink Everlasting",
    colors: ["#d3a2a8", "#c9bd8e", "#a3b0a0", "#9a9894"],
    backing: "#f7f1ef",
    speed: 1.1,
    params: {
      count: 7,
      swing: 40,
      period: 100,
      paddle: 0.85,
      clearance: 0.42,
      depth: 32,
      seed: 23,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Cowslip Orchid",
    colors: ["#d8c27e", "#a7ad8a", "#b9a291", "#9a958b"],
    backing: "#f6f3e8",
    speed: 1,
    params: {
      count: 6,
      swing: 45,
      period: 180,
      paddle: 1.25,
      clearance: 0.55,
      depth: 40,
      seed: 41,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Pincushion Hakea",
    colors: ["#c98f86", "#e0d0b2", "#9aa7b8", "#9b9590"],
    backing: "#f6f0ea",
    speed: 0.9,
    params: {
      count: 4,
      swing: 32,
      period: 90,
      paddle: 1.4,
      clearance: 0.6,
      depth: 42,
      seed: 58,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Quandong",
    colors: ["#5b3a31", "#2f4453", "#665b37", "#2a2f2d"],
    backing: "#0e1011",
    speed: 1,
    params: SKETCH,
  }),
  preset("dark", {
    id: "p7",
    name: "Mountain Devil",
    colors: ["#5e2f2b", "#3b3a2a", "#6a5030", "#2b2523"],
    backing: "#100c0b",
    speed: 0.9,
    params: {
      count: 7,
      swing: 30,
      period: 140,
      paddle: 0.9,
      clearance: 0.48,
      depth: 36,
      seed: 13,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Sturt Desert Pea",
    colors: ["#6a2a26", "#4e4a3f", "#5c5a4e", "#262222"],
    backing: "#0d0b0b",
    speed: 1.1,
    params: {
      count: 5,
      swing: 50,
      period: 200,
      paddle: 1.2,
      clearance: 0.52,
      depth: 30,
      seed: 77,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Native Fuchsia",
    colors: ["#5d3446", "#35473a", "#6b5a46", "#262a2a"],
    backing: "#0c0e0f",
    speed: 1,
    params: {
      count: 6,
      swing: 25,
      period: 110,
      paddle: 1.05,
      clearance: 0.4,
      depth: 44,
      seed: 89,
    },
  }),
];
