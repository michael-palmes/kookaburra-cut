import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { TesseraDome } from "./TesseraDome";

export const look: Scene3dBackgroundDef = {
  id: "tessera-dome",
  name: "Tessera dome",
  family: "history",
  colorSlots: [
    { label: "Gold", fallback: "#4a3c24" },
    { label: "Grout", fallback: "#221c14" },
    { label: "Glint", fallback: "#6d6045" },
  ],
  params: {
    rimRadius: { label: "Rim radius", default: 35, min: 25, max: 45, step: 0.5 },
    rise: { label: "Dome rise", default: 24, min: 12, max: 35, step: 0.5 },
    tileSize: { label: "Tile size", default: 0.8, min: 0.6, max: 1.4, step: 0.05 },
    tilt: { label: "Tile tilt", default: 6, min: 0, max: 12, step: 0.5 },
    glint: { label: "Glint", default: 0.8, min: 0, max: 1, step: 0.01 },
    glintPeriod: { label: "Glint period (s)", default: 60, min: 30, max: 180, step: 5 },
    rimFade: { label: "Rim fade", default: 3.7, min: 1, max: 8, step: 0.1 },
  },
  previewCamera: "ceiling",
  Component: TesseraDome,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "params"> & {
  params: Record<
    "rimRadius" | "rise" | "tileSize" | "tilt" | "glint" | "glintPeriod" | "rimFade",
    number
  >;
};

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
});

/** South Australian opal and outback towns. The vault fades into the backing at the springing line, so `backing` is the air under the dome. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Glenelg",
    colors: ["#d9c697", "#a8987a", "#f8f1dc"],
    backing: "#f1eadb",
    speed: 1,
    params: {
      rimRadius: 35,
      rise: 24,
      tileSize: 0.8,
      tilt: 6,
      glint: 0.8,
      glintPeriod: 60,
      rimFade: 3.7,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Hawker",
    colors: ["#dcbd8c", "#aa9277", "#f8eed8"],
    backing: "#f3eadb",
    speed: 1,
    params: {
      rimRadius: 38,
      rise: 20,
      tileSize: 1,
      tilt: 8,
      glint: 0.7,
      glintPeriod: 75,
      rimFade: 3,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Quorn",
    colors: ["#cfc8b0", "#9d9786", "#f4f2e6"],
    backing: "#f2f0e7",
    speed: 1,
    params: {
      rimRadius: 32,
      rise: 28,
      tileSize: 0.7,
      tilt: 5,
      glint: 0.85,
      glintPeriod: 50,
      rimFade: 4.2,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Farina",
    colors: ["#d9baa3", "#a99184", "#f5e7dc"],
    backing: "#f4ebe5",
    speed: 0.9,
    params: {
      rimRadius: 40,
      rise: 18,
      tileSize: 1.2,
      tilt: 10,
      glint: 0.6,
      glintPeriod: 90,
      rimFade: 3.2,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Beltana",
    colors: ["#c6c59a", "#98987e", "#f1f0d8"],
    backing: "#eff0e2",
    speed: 1.1,
    params: {
      rimRadius: 30,
      rise: 26,
      tileSize: 0.9,
      tilt: 4,
      glint: 0.9,
      glintPeriod: 45,
      rimFade: 4,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Andamooka",
    colors: ["#4a3c24", "#221c14", "#6d6045"],
    backing: "#18140e",
    speed: 1,
    params: {
      rimRadius: 35,
      rise: 24,
      tileSize: 0.8,
      tilt: 6,
      glint: 0.8,
      glintPeriod: 60,
      rimFade: 3.7,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Mintabie",
    colors: ["#2b3550", "#141a27", "#4f5d78"],
    backing: "#0f131d",
    speed: 1,
    params: {
      rimRadius: 33,
      rise: 27,
      tileSize: 0.75,
      tilt: 7,
      glint: 0.85,
      glintPeriod: 55,
      rimFade: 4,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Lambina",
    colors: ["#4c2d26", "#22150f", "#6e5040"],
    backing: "#18100c",
    speed: 0.9,
    params: {
      rimRadius: 40,
      rise: 19,
      tileSize: 1.1,
      tilt: 9,
      glint: 0.7,
      glintPeriod: 80,
      rimFade: 3.2,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Tarcoola",
    colors: ["#37412b", "#191e13", "#5b6246"],
    backing: "#12150d",
    speed: 1.1,
    params: {
      rimRadius: 30,
      rise: 22,
      tileSize: 0.9,
      tilt: 5,
      glint: 0.9,
      glintPeriod: 45,
      rimFade: 3.5,
    },
  }),
];
