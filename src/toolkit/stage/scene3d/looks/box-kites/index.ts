import { goboCompanionSun } from "../../kit/gobo";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { BoxKites } from "./BoxKites";
import { KITE_SUN } from "./kites";

/** Box kites (kinetic): Hargrave's cellular box kites as calico and cedar objects on long lines ringing the sky, trains of two and three, over a flooded salt lake that mirrors them. */
export const look: Scene3dBackgroundDef = {
  id: "box-kites",
  name: "Box kites",
  family: "kinetic",
  colorSlots: [
    { label: "Sail", fallback: "#62563f" },
    { label: "Cell", fallback: "#3a4a52" },
    { label: "Line", fallback: "#2a2624" },
    { label: "Lamp", fallback: "#b8864a", glow: true },
  ],
  params: {
    lines: { label: "Kite lines", default: 8, min: 3, max: 12, step: 1 },
    train: { label: "Train length", default: 3, min: 1, max: 4, step: 1 },
    height: { label: "Flying height", default: 1, min: 0.7, max: 1.4, step: 0.05 },
    size: { label: "Kite size", default: 3, min: 2, max: 4.5, step: 0.1 },
    veer: { label: "Wind veer (deg)", default: 13, min: 0, max: 30, step: 0.5 },
    figure: { label: "Figure eight", default: 1, min: 0, max: 2, step: 0.05 },
    reflect: { label: "Lake reflection", default: 0.24, min: 0, max: 0.5, step: 0.01 },
  },
  previewCamera: "ceiling",
  Component: BoxKites,
};

/** Matching rig: a high soft sun from the bearing of the virtual sun that shades the cells. */
function kitesLighting(mode: "light" | "dark", kelvin: number): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: {
      source: dark ? "kookaburra:night-city" : "kookaburra:dawn",
      intensity: dark ? 0.35 : 0.8,
      rotationDeg: 0,
    },
    sun: goboCompanionSun(KITE_SUN, { intensity: dark ? 1.2 : 2, kelvin, angularDeg: 3 }),
    ambient: dark ? 0.15 : 0.4,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", kelvin: number, p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: kitesLighting(mode, kelvin),
});

/** Central Australian landmarks and stations. p1 and p6 are the approved sketch palettes (p1's line lifted to the Theme tile floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", 5200, {
    id: "p1",
    name: "Coolibah",
    colors: ["#d8c6a6", "#a4b3b9", "#a5988e", "#d4a870"],
    backing: "#f4f1ec",
    speed: 1,
    params: {
      lines: 8,
      train: 3,
      height: 1,
      size: 3,
      veer: 13,
      figure: 1,
      reflect: 0.24,
    },
  }),
  preset("light", 4800, {
    id: "p2",
    name: "Corroboree Rock",
    colors: ["#dcbfa0", "#b3a6a0", "#a79486", "#d49f74"],
    backing: "#f6efe7",
    speed: 1,
    params: {
      lines: 6,
      train: 2,
      height: 1.05,
      size: 3.6,
      veer: 18,
      figure: 1.3,
      reflect: 0.2,
    },
  }),
  preset("light", 5600, {
    id: "p3",
    name: "Old Andado",
    colors: ["#d0cdb2", "#9fb0a4", "#9c9a8a", "#ccab6c"],
    backing: "#f2f2ea",
    speed: 1,
    params: {
      lines: 10,
      train: 3,
      height: 0.9,
      size: 2.6,
      veer: 9,
      figure: 0.8,
      reflect: 0.28,
    },
  }),
  preset("light", 6000, {
    id: "p4",
    name: "Curtin Springs",
    colors: ["#e0d2b8", "#9fb4c6", "#9a98a0", "#d0a27a"],
    backing: "#f1f4f6",
    speed: 1,
    params: {
      lines: 5,
      train: 4,
      height: 1.1,
      size: 3.2,
      veer: 22,
      figure: 1.1,
      reflect: 0.18,
    },
  }),
  preset("light", 4600, {
    id: "p5",
    name: "Undoolya",
    colors: ["#dcc4b8", "#b4a5b8", "#a59392", "#d6a07e"],
    backing: "#f7f0ee",
    speed: 1,
    params: {
      lines: 12,
      train: 2,
      height: 1.1,
      size: 2.4,
      veer: 15,
      figure: 1.5,
      reflect: 0.22,
    },
  }),
  preset("dark", 4200, {
    id: "p6",
    name: "Chambers Pillar",
    colors: ["#62563f", "#3a4a52", "#2a2624", "#b8864a"],
    backing: "#0b0c0e",
    speed: 1,
    params: {
      lines: 8,
      train: 3,
      height: 1,
      size: 3,
      veer: 13,
      figure: 1,
      reflect: 0.28,
    },
  }),
  preset("dark", 4000, {
    id: "p7",
    name: "Tempe Downs",
    colors: ["#5e5a46", "#3f4e44", "#2b2a26", "#b08850"],
    backing: "#0b0d0b",
    speed: 1,
    params: {
      lines: 7,
      train: 4,
      height: 1.05,
      size: 3.4,
      veer: 11,
      figure: 0.9,
      reflect: 0.26,
    },
  }),
  preset("dark", 3800, {
    id: "p8",
    name: "Ooraminna",
    colors: ["#66503f", "#47424f", "#2d2526", "#bc8260"],
    backing: "#0e0b0c",
    speed: 1,
    params: {
      lines: 10,
      train: 2,
      height: 0.95,
      size: 2.8,
      veer: 20,
      figure: 1.4,
      reflect: 0.3,
    },
  }),
  preset("dark", 4400, {
    id: "p9",
    name: "Lilla Creek",
    colors: ["#57584e", "#384656", "#24272b", "#a48c5d"],
    backing: "#0a0c10",
    speed: 1,
    params: {
      lines: 9,
      train: 3,
      height: 1.1,
      size: 3,
      veer: 25,
      figure: 0.7,
      reflect: 0.25,
    },
  }),
];
