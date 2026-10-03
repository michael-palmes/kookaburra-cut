import { goboCompanionSun } from "../../kit/gobo";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { SAND } from "./rose";
import { SandTable } from "./SandTable";

/** Sand table (kinetic): a Sisyphus sand dish where a steel ball ploughs a precessing rose of raked bands that relax flat with age, lit by a swinging virtual sun. */
export const look: Scene3dBackgroundDef = {
  id: "sand-table",
  name: "Sand table",
  family: "kinetic",
  colorSlots: [
    { label: "Sand", fallback: "#2a251e" },
    { label: "Groove", fallback: "#16130f" },
    { label: "Ridge", fallback: "#635747" },
    { label: "Ball", fallback: "#4c5257" },
  ],
  params: {
    clearRadius: { label: "Clearing", default: 7.5, min: 5, max: 14, step: 0.5 },
    reach: { label: "Reach", default: 29, min: 18, max: 40, step: 0.5 },
    petals: { label: "Petals", default: 25, min: 7, max: 41, step: 1 },
    grooves: { label: "Grooves", default: 6, min: 3, max: 9, step: 1 },
    memory: { label: "Memory (s)", default: 1500, min: 300, max: 1800, step: 10 },
    sunSwing: { label: "Sun swing", default: 40, min: 0, max: 90, step: 1 },
    sunHeight: { label: "Sun height", default: 22, min: 10, max: 45, step: 1 },
    rise: { label: "Dish rise", default: 5, min: 0, max: 8, step: 0.1 },
  },
  previewCamera: "static",
  Component: SandTable,
};

/** Matching rig: a low warm key from the virtual sun's bearing at the start of its slow turn, so device shadows rake the way the grooves do. Companion blocks are static, so the swing and turn are left out. */
function sandLighting(
  mode: "light" | "dark",
  height: number,
  kelvin: number,
): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:dawn", intensity: dark ? 0.3 : 0.65, rotationDeg: 0 },
    sun: goboCompanionSun(
      { azimuthDeg: Math.round((SAND.sunAzimuth * 180) / Math.PI), elevationDeg: height },
      { intensity: dark ? 1.1 : 1.6, kelvin, angularDeg: 2 },
    ),
    ambient: dark ? 0.2 : 0.45,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting" | "params"> & {
  params: Record<string, number>;
};

const preset = (mode: "light" | "dark", kelvin: number, p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: sandLighting(mode, p.params.sunHeight, kelvin),
});

/** Australian islands. p1 and p6 are the approved sketch palettes (p1's groove lifted to the Theme tile floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", 4300, {
    id: "p1",
    name: "Lady Elliot",
    colors: ["#e2d6bd", "#a89877", "#f1e9d8", "#9da3a8"],
    backing: "#f6f1e7",
    speed: 1,
    params: {
      clearRadius: 7.5,
      reach: 29,
      petals: 25,
      grooves: 6,
      memory: 1500,
      sunSwing: 40,
      sunHeight: 22,
      rise: 5,
    },
  }),
  preset("light", 5200, {
    id: "p2",
    name: "Masthead Island",
    colors: ["#dcdcd2", "#989a90", "#eeeee6", "#a39c94"],
    backing: "#f4f4ef",
    speed: 1.1,
    params: {
      clearRadius: 8,
      reach: 32,
      petals: 31,
      grooves: 5,
      memory: 1200,
      sunSwing: 50,
      sunHeight: 18,
      rise: 5.6,
    },
  }),
  preset("light", 4000, {
    id: "p3",
    name: "Penguin Island",
    colors: ["#e3d2c8", "#a8938a", "#f2e6df", "#9aa0a8"],
    backing: "#f7f1ec",
    speed: 0.9,
    params: {
      clearRadius: 7,
      reach: 26,
      petals: 19,
      grooves: 7,
      memory: 1650,
      sunSwing: 35,
      sunHeight: 26,
      rise: 4.4,
    },
  }),
  preset("light", 4800, {
    id: "p4",
    name: "Rodd Island",
    colors: ["#d6d8c8", "#959b87", "#e9ebdd", "#a59a8c"],
    backing: "#f2f3eb",
    speed: 1.2,
    params: {
      clearRadius: 9,
      reach: 24,
      petals: 13,
      grooves: 4,
      memory: 900,
      sunSwing: 60,
      sunHeight: 20,
      rise: 4,
    },
  }),
  preset("light", 3800, {
    id: "p5",
    name: "Wilson Island",
    colors: ["#e6d3a8", "#ab9564", "#f3e6c6", "#9ea2a6"],
    backing: "#f8f2e2",
    speed: 0.8,
    params: {
      clearRadius: 8.5,
      reach: 34,
      petals: 37,
      grooves: 8,
      memory: 1800,
      sunSwing: 30,
      sunHeight: 30,
      rise: 6,
    },
  }),
  preset("dark", 3600, {
    id: "p6",
    name: "Dirk Hartog",
    colors: ["#2a251e", "#16130f", "#635747", "#4c5257"],
    backing: "#110f0c",
    speed: 1,
    params: {
      clearRadius: 7.5,
      reach: 29,
      petals: 25,
      grooves: 6,
      memory: 1500,
      sunSwing: 40,
      sunHeight: 22,
      rise: 5,
    },
  }),
  preset("dark", 5600, {
    id: "p7",
    name: "Maria Island",
    colors: ["#22262b", "#121417", "#545d68", "#5f5a52"],
    backing: "#0e1012",
    speed: 1.1,
    params: {
      clearRadius: 8,
      reach: 31,
      petals: 29,
      grooves: 5,
      memory: 1300,
      sunSwing: 55,
      sunHeight: 18,
      rise: 5.6,
    },
  }),
  preset("dark", 4600, {
    id: "p8",
    name: "Three Hummock",
    colors: ["#232820", "#121510", "#56614e", "#5a5650"],
    backing: "#0e110d",
    speed: 0.9,
    params: {
      clearRadius: 7,
      reach: 27,
      petals: 17,
      grooves: 7,
      memory: 1700,
      sunSwing: 35,
      sunHeight: 28,
      rise: 4.4,
    },
  }),
  preset("dark", 3300, {
    id: "p9",
    name: "Groote Eylandt",
    colors: ["#2c211c", "#17100d", "#6b4c3e", "#50555a"],
    backing: "#120c0a",
    speed: 1,
    params: {
      clearRadius: 8.5,
      reach: 35,
      petals: 33,
      grooves: 6,
      memory: 1100,
      sunSwing: 45,
      sunHeight: 20,
      rise: 6,
    },
  }),
];
