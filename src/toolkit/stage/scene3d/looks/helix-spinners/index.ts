import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { HelixSpinners } from "./HelixSpinners";
import { MAX_SPINNERS, MIN_SPINNERS } from "./spinners";

export const look: Scene3dBackgroundDef = {
  id: "helix-spinners",
  name: "Helix spinners",
  family: "kinetic",
  colorSlots: [
    { label: "Helix A", fallback: "#6d523e" },
    { label: "Helix B", fallback: "#3a4b53" },
    { label: "Rod", fallback: "#221e1b" },
  ],
  params: {
    count: { label: "Spinners", default: 26, min: MIN_SPINNERS, max: MAX_SPINNERS, step: 1 },
    length: { label: "Length", default: 1, min: 0.6, max: 1.6, step: 0.05 },
    twist: { label: "Twist (deg a bar)", default: 14, min: 6, max: 24, step: 0.5 },
    turn: { label: "Turn (s)", default: 24, min: 12, max: 60, step: 1 },
    clearance: { label: "Clearance (deg)", default: 12, min: 9, max: 18, step: 0.5 },
    rods: { label: "Rod opacity", default: 0.35, min: 0, max: 0.6, step: 0.01 },
  },
  previewCamera: "ceiling",
  Component: HelixSpinners,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
});

const SKETCH = {
  count: 26,
  length: 1,
  twist: 14,
  turn: 24,
  clearance: 12,
  rods: 0.35,
};

export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Corkwood",
    colors: ["#c9b395", "#9fb0b4", "#a2988c"],
    backing: "#f4f1eb",
    speed: 1,
    params: SKETCH,
  }),
  preset("light", {
    id: "p2",
    name: "Serpentine Gorge",
    colors: ["#c8a08c", "#a3ae9c", "#9c988f"],
    backing: "#f4f2ed",
    speed: 0.9,
    params: {
      count: 20,
      length: 1.2,
      twist: 10,
      turn: 30,
      clearance: 13,
      rods: 0.3,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Chewings Range",
    colors: ["#cfa59a", "#a8b4bf", "#a0978f"],
    backing: "#f6f1ee",
    speed: 1,
    params: {
      count: 34,
      length: 0.85,
      twist: 18,
      turn: 20,
      clearance: 12,
      rods: 0.4,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Ruby Gap",
    colors: ["#c2948f", "#cbbf94", "#9c968c"],
    backing: "#f5f2ea",
    speed: 1.1,
    params: {
      count: 16,
      length: 1.35,
      twist: 8,
      turn: 36,
      clearance: 14,
      rods: 0.25,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Glen Helen",
    colors: ["#cdb07e", "#a9b6ad", "#9d9a90"],
    backing: "#f4f3ec",
    speed: 0.85,
    params: {
      count: 40,
      length: 0.75,
      twist: 20,
      turn: 16,
      clearance: 11,
      rods: 0.45,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Redbank",
    colors: ["#6d523e", "#3a4b53", "#221e1b"],
    backing: "#0c0b0a",
    speed: 1,
    params: SKETCH,
  }),
  preset("dark", {
    id: "p7",
    name: "Weetootla Gorge",
    colors: ["#76473a", "#2f4a4a", "#201d1c"],
    backing: "#0b0c0c",
    speed: 0.9,
    params: {
      count: 30,
      length: 1.1,
      twist: 12,
      turn: 28,
      clearance: 13,
      rods: 0.4,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Heavitree Gap",
    colors: ["#5a5248", "#6a4030", "#1f1c1a"],
    backing: "#0d0b0a",
    speed: 1,
    params: {
      count: 22,
      length: 1.4,
      twist: 16,
      turn: 22,
      clearance: 15,
      rods: 0.3,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Arkaroola",
    colors: ["#674a5a", "#565a3c", "#1e1d20"],
    backing: "#0b0b0d",
    speed: 1.1,
    params: {
      count: 44,
      length: 0.8,
      twist: 22,
      turn: 18,
      clearance: 12,
      rods: 0.5,
    },
  }),
];
