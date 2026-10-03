import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { LilyPond } from "./LilyPond";

export const look: Scene3dBackgroundDef = {
  id: "lily-pond",
  name: "Lily pond",
  family: "painted",
  colorSlots: [
    { label: "Water deep", fallback: "#0f1720" },
    { label: "Water sky", fallback: "#2f4151" },
    { label: "Pad", fallback: "#1e3128" },
    { label: "Blossom", fallback: "#80506a" },
  ],
  params: {
    clearRadius: { label: "Clearing", default: 7, min: 4, max: 14, step: 0.5 },
    padCount: { label: "Pads", default: 200, min: 0, max: 400, step: 10 },
    blossoms: { label: "Blossoms", default: 0.12, min: 0, max: 0.4, step: 0.01 },
    strokeScale: { label: "Stroke size", default: 1, min: 0.5, max: 2, step: 0.05 },
    ripples: { label: "Ripples", default: 6, min: 0, max: 10, step: 1 },
    drift: { label: "Drift speed", default: 1, min: 0, max: 2, step: 0.05 },
  },
  Component: LilyPond,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
});

/** NSW lakes and wetlands. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Centennial",
    colors: ["#7c9faa", "#c1d1da", "#a2b9a5", "#eedde3"],
    backing: "#f2f2eb",
    speed: 1,
    params: {
      clearRadius: 7,
      padCount: 200,
      blossoms: 0.12,
      strokeScale: 1,
      ripples: 6,
      drift: 1,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Lake Ainsworth",
    colors: ["#9f9883", "#d6d4c4", "#a9b394", "#ecd9c6"],
    backing: "#f5f2ea",
    speed: 0.9,
    params: {
      clearRadius: 6,
      padCount: 260,
      blossoms: 0.08,
      strokeScale: 0.8,
      ripples: 4,
      drift: 0.8,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Smiths Lake",
    colors: ["#7f9d9c", "#c8dbd6", "#a7bd9c", "#f0dce6"],
    backing: "#f1f4f1",
    speed: 1.1,
    params: {
      clearRadius: 8,
      padCount: 140,
      blossoms: 0.15,
      strokeScale: 1.3,
      ripples: 9,
      drift: 1.2,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Wallis Lake",
    colors: ["#9496ac", "#d3d3e0", "#a9b5a4", "#ecd2dc"],
    backing: "#f4f2f5",
    speed: 0.9,
    params: {
      clearRadius: 9,
      padCount: 320,
      blossoms: 0.2,
      strokeScale: 1.15,
      ripples: 5,
      drift: 0.6,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Lake Cathie",
    colors: ["#8d9c9f", "#dfe2dc", "#b8c2a2", "#f2e2c8"],
    backing: "#f7f6f0",
    speed: 1,
    params: {
      clearRadius: 5,
      padCount: 120,
      blossoms: 0.3,
      strokeScale: 0.7,
      ripples: 3,
      drift: 1.5,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Myall Lakes",
    colors: ["#0f1720", "#2f4151", "#1e3128", "#80506a"],
    backing: "#141c2a",
    speed: 1,
    params: {
      clearRadius: 7,
      padCount: 200,
      blossoms: 0.12,
      strokeScale: 1,
      ripples: 6,
      drift: 1,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Gwydir Wetlands",
    colors: ["#11160f", "#3d4e43", "#2f4329", "#765c3d"],
    backing: "#121812",
    speed: 0.9,
    params: {
      clearRadius: 8,
      padCount: 300,
      blossoms: 0.08,
      strokeScale: 1.3,
      ripples: 4,
      drift: 0.7,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Fivebough",
    colors: ["#141220", "#463f63", "#33402f", "#775473"],
    backing: "#16141f",
    speed: 1.1,
    params: {
      clearRadius: 6,
      padCount: 150,
      blossoms: 0.25,
      strokeScale: 0.8,
      ripples: 8,
      drift: 1.3,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Narran Lakes",
    colors: ["#0c1a1c", "#2f5059", "#27463d", "#72595d"],
    backing: "#0f1a1d",
    speed: 0.9,
    params: {
      clearRadius: 10,
      padCount: 380,
      blossoms: 0.05,
      strokeScale: 1.6,
      ripples: 2,
      drift: 0.5,
    },
  }),
];
