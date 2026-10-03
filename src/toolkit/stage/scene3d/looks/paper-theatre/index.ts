import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { PaperTheatre } from "./PaperTheatre";
import { theatreLighting } from "./theatre";

/** Paper theatre (painted): a Victorian toy theatre and Reiniger multiplane, card flats in rings round the stage. */
export const look: Scene3dBackgroundDef = {
  id: "paper-theatre",
  name: "Paper theatre",
  family: "painted",
  colorSlots: [
    { label: "Near card", fallback: "#4a5a6b" },
    { label: "Mid card", fallback: "#27333f" },
    { label: "Far card", fallback: "#161d29" },
    { label: "Sun disc", fallback: "#9f926b", glow: true },
  ],
  params: {
    rings: { label: "Rings", default: 4, min: 2, max: 5, step: 1 },
    flatHeight: { label: "Flat height", default: 1, min: 0.5, max: 1.6, step: 0.05 },
    treeDensity: { label: "Trees", default: 0.78, min: 0, max: 1, step: 0.01 },
    rock: { label: "Rock (deg)", default: 1.8, min: 0, max: 3, step: 0.1 },
    shadow: { label: "Shadow", default: 0.55, min: 0, max: 1, step: 0.01 },
    cloudSpeed: { label: "Cloud speed", default: 1, min: 0, max: 3, step: 0.05 },
    stopMotion: { label: "Stop motion fps", default: 0, min: 0, max: 12, step: 1 },
  },
  Component: PaperTheatre,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: theatreLighting(mode),
});

/** Tasmania's east coast and islands. p1 and p6 are the approved sketch palettes (p1's near card nudged to the 0.315 floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Bruny",
    colors: ["#909d86", "#abb8ae", "#cad4d6", "#ebc88f"],
    backing: "#f4f0e8",
    speed: 1,
    params: {
      rings: 4,
      flatHeight: 1,
      treeDensity: 0.78,
      rock: 1.8,
      shadow: 0.55,
      cloudSpeed: 1,
      stopMotion: 0,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Painted Cliffs",
    colors: ["#ab9179", "#c9b8a4", "#ddd3c8", "#e9b98a"],
    backing: "#f6efe6",
    speed: 0.9,
    params: {
      rings: 5,
      flatHeight: 0.85,
      treeDensity: 0.4,
      rock: 1.2,
      shadow: 0.7,
      cloudSpeed: 0.7,
      stopMotion: 0,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Binalong Bay",
    colors: ["#869a9d", "#b5c4c2", "#d6dfdc", "#e8b07e"],
    backing: "#f2f4f0",
    speed: 1,
    params: {
      rings: 3,
      flatHeight: 1.2,
      treeDensity: 0,
      rock: 2.2,
      shadow: 0.45,
      cloudSpeed: 1.4,
      stopMotion: 8,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Friendly Beaches",
    colors: ["#9399ad", "#c0c6cf", "#dde0e4", "#efd3a1"],
    backing: "#f7f5f0",
    speed: 1.1,
    params: {
      rings: 4,
      flatHeight: 0.7,
      treeDensity: 0.6,
      rock: 1.6,
      shadow: 0.6,
      cloudSpeed: 1.8,
      stopMotion: 0,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Schouten Island",
    colors: ["#a3929e", "#c2b4bc", "#ddd2d6", "#ecc29b"],
    backing: "#f7f1f0",
    speed: 0.85,
    params: {
      rings: 5,
      flatHeight: 1.4,
      treeDensity: 1,
      rock: 2.4,
      shadow: 0.5,
      cloudSpeed: 0.9,
      stopMotion: 6,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Lake Pedder",
    colors: ["#4a5a6b", "#27333f", "#161d29", "#9f926b"],
    backing: "#0a0d15",
    speed: 1,
    params: {
      rings: 4,
      flatHeight: 1,
      treeDensity: 0.78,
      rock: 1.8,
      shadow: 0.55,
      cloudSpeed: 1,
      stopMotion: 0,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Cape Tourville",
    colors: ["#3a5a5a", "#22383a", "#132224", "#9c9075"],
    backing: "#081314",
    speed: 0.9,
    params: {
      rings: 5,
      flatHeight: 1.3,
      treeDensity: 0.5,
      rock: 1.4,
      shadow: 0.7,
      cloudSpeed: 0.8,
      stopMotion: 0,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Eddystone Point",
    colors: ["#5e5650", "#35302d", "#1d1a19", "#a8865e"],
    backing: "#0d0b0b",
    speed: 1,
    params: {
      rings: 3,
      flatHeight: 1.1,
      treeDensity: 0,
      rock: 2.6,
      shadow: 0.6,
      cloudSpeed: 1.3,
      stopMotion: 10,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Moulting Lagoon",
    colors: ["#5a4d63", "#342b3c", "#1d1824", "#a68a8a"],
    backing: "#0d0a12",
    speed: 1.1,
    params: {
      rings: 4,
      flatHeight: 0.8,
      treeDensity: 0.9,
      rock: 2,
      shadow: 0.5,
      cloudSpeed: 2.2,
      stopMotion: 0,
    },
  }),
];
