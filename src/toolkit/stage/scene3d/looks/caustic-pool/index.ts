import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { CausticPool } from "./CausticPool";
import { poolLighting } from "./pool";

/** Caustic pool (atmosphere): sunlight nets wandering over a tiled pool floor, under a faint rippled surface seen from below. */
export const look: Scene3dBackgroundDef = {
  id: "caustic-pool",
  name: "Caustic pool",
  family: "atmosphere",
  colorSlots: [
    { label: "Tile", fallback: "#0d1c23" },
    { label: "Grout", fallback: "#18313a" },
    { label: "Caustic", fallback: "#336b61" },
  ],
  params: {
    tile: { label: "Tile size", default: 1.5, min: 0.8, max: 3, step: 0.05 },
    grout: { label: "Grout", default: 0.35, min: 0, max: 1, step: 0.05 },
    scale: { label: "Caustic scale", default: 6, min: 4, max: 12, step: 0.25 },
    strength: { label: "Caustic strength", default: 0.55, min: 0.2, max: 0.9, step: 0.05 },
    clearRadius: { label: "Clearing", default: 6, min: 4, max: 12, step: 0.25 },
    loop: { label: "Loop period (s)", default: 240, min: 120, max: 480, step: 10 },
    surface: { label: "Surface", default: 1, min: 0, max: 1, step: 0.05 },
  },
  Component: CausticPool,
};

type Mode = "light" | "dark";

const preset = (
  id: string,
  name: string,
  mode: Mode,
  colors: string[],
  backing: string,
  speed: number,
  kelvin: number,
  params: Record<string, number>,
): Scene3dBackgroundPreset => ({
  id,
  name,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  colors,
  backing,
  speed,
  params,
  lighting: poolLighting(mode, kelvin),
});

/** Northern Territory waterholes and gorges. p1 and p6 are the approved sketch palettes (p1's tile lifted to the Theme tile floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("p1", "Wangi Falls", "light", ["#56a5ad", "#a9d3d6", "#ebf7f5"], "#b8d4d9", 1, 7000, {
    tile: 1.5,
    grout: 0.35,
    scale: 6,
    strength: 0.55,
    clearRadius: 6,
    loop: 240,
    surface: 1,
  }),
  preset("p2", "Florence Falls", "light", ["#6aa596", "#b8d8cc", "#eef7ef"], "#c4dbd2", 0.9, 6500, {
    tile: 2.2,
    grout: 0.25,
    scale: 8,
    strength: 0.5,
    clearRadius: 7,
    loop: 300,
    surface: 0.8,
  }),
  preset("p3", "Buley Rockhole", "light", ["#aa9373", "#d9ccb4", "#f8f2e4"], "#e2d8c6", 1.1, 5600, {
    tile: 1,
    grout: 0.5,
    scale: 5,
    strength: 0.6,
    clearRadius: 5,
    loop: 180,
    surface: 0.6,
  }),
  preset("p4", "Edith Falls", "light", ["#809cb9", "#c3d1df", "#eef3f9"], "#ccd8e5", 0.8, 7500, {
    tile: 1.8,
    grout: 0.3,
    scale: 7,
    strength: 0.45,
    clearRadius: 8,
    loop: 360,
    surface: 1,
  }),
  preset("p5", "Gunlom", "light", ["#b69386", "#dfccc4", "#fbf3ee"], "#e6d6cf", 1.2, 6000, {
    tile: 1.2,
    grout: 0.4,
    scale: 10,
    strength: 0.7,
    clearRadius: 6,
    loop: 200,
    surface: 0.7,
  }),
  preset("p6", "Bitter Springs", "dark", ["#0d1c23", "#18313a", "#336b61"], "#11252e", 1, 7500, {
    tile: 1.5,
    grout: 0.35,
    scale: 6,
    strength: 0.55,
    clearRadius: 6,
    loop: 240,
    surface: 1,
  }),
  preset("p7", "Redbank Gorge", "dark", ["#121921", "#212b36", "#485c6e"], "#0e141a", 0.9, 8000, {
    tile: 2,
    grout: 0.45,
    scale: 9,
    strength: 0.6,
    clearRadius: 7,
    loop: 320,
    surface: 1,
  }),
  preset("p8", "Trephina Gorge", "dark", ["#21140f", "#37241b", "#76523f"], "#170e0b", 1.1, 5000, {
    tile: 1.2,
    grout: 0.3,
    scale: 5,
    strength: 0.5,
    clearRadius: 5,
    loop: 200,
    surface: 0.7,
  }),
  preset("p9", "Maguk", "dark", ["#0e1c15", "#1b3125", "#416a54"], "#0b1611", 1, 6800, {
    tile: 1.6,
    grout: 0.25,
    scale: 7,
    strength: 0.7,
    clearRadius: 9,
    loop: 280,
    surface: 0.9,
  }),
];
