import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { LouvreRing } from "./LouvreRing";
import { LOUVRE } from "./louvre";

/** Louvre ring (kinetic): venetian blinds and brise-soleil, via Tyler Short's Penumbra louvres and Ned Kahn's Wind Veil. */
export const look: Scene3dBackgroundDef = {
  id: "louvre-ring",
  name: "Louvre ring",
  family: "kinetic",
  colorSlots: [
    { label: "Face A", fallback: "#222b30" },
    { label: "Face B", fallback: "#61564a" },
    { label: "Frame", fallback: "#30373a" },
  ],
  params: {
    count: { label: "Slats", default: 160, min: 80, max: LOUVRE.maxSlats, step: 4 },
    radius: { label: "Radius", default: 13.5, min: 11, max: 20, step: 0.5 },
    height: { label: "Height", default: 8, min: 4, max: 12, step: 0.5 },
    period: { label: "Sweep (s)", default: 48, min: 30, max: 120, step: 1 },
    front: { label: "Front width", default: 0.3, min: 0.1, max: 0.6, step: 0.01 },
    rows: { label: "Rows", default: 1, min: 1, max: LOUVRE.maxRows, step: 1 },
  },
  Component: LouvreRing,
};

/** Matching rig: a soft key from the fixed virtual light that shades the slats, over a quiet environment. */
export function louvreLighting(mode: "light" | "dark"): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: {
      source: dark ? "kookaburra:interior" : "kookaburra:softbox",
      intensity: dark ? 0.3 : 0.65,
      rotationDeg: 0,
    },
    sun: {
      azimuthDeg: LOUVRE.sunAzimuthDeg,
      elevationDeg: LOUVRE.sunElevationDeg,
      intensity: dark ? 1.4 : 1.8,
      kelvin: 4800,
    },
    ambient: dark ? 0.15 : 0.35,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: louvreLighting(mode),
});

/** Australian native trees. p1 and p6 are the approved sketch palettes (p1's Face B nudged to the 0.315 floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Grevillea",
    colors: ["#cdc8ba", "#8a9ea6", "#bcc1bc"],
    backing: "#f4f2ec",
    speed: 1,
    params: { count: 160, radius: 13.5, height: 8, period: 48, front: 0.3, rows: 1 },
  }),
  preset("light", {
    id: "p2",
    name: "Snow Gum",
    colors: ["#c2c0b4", "#8d9a82", "#b4b6a9"],
    backing: "#f5f5f1",
    speed: 0.9,
    params: {
      count: 220,
      radius: 14.5,
      height: 7,
      period: 60,
      front: 0.4,
      rows: 2,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Coolabah",
    colors: ["#d0bc9f", "#aa937c", "#c0b2a0"],
    backing: "#f7f2ea",
    speed: 1,
    params: {
      count: 120,
      radius: 13,
      height: 6.5,
      period: 40,
      front: 0.25,
      rows: 1,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Scribbly Gum",
    colors: ["#c0bfc9", "#9894ac", "#b3b2bf"],
    backing: "#f4f4f7",
    speed: 0.8,
    params: { count: 260, radius: 15, height: 9, period: 72, front: 0.45, rows: 3 },
  }),
  preset("light", {
    id: "p5",
    name: "Lemon Myrtle",
    colors: ["#cac7a3", "#979a6f", "#bab9a0"],
    backing: "#f7f7ec",
    speed: 1.1,
    params: {
      count: 100,
      radius: 12.5,
      height: 7.5,
      period: 36,
      front: 0.2,
      rows: 1,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Casuarina",
    colors: ["#222b30", "#61564a", "#30373a"],
    backing: "#0e1214",
    speed: 1,
    params: { count: 160, radius: 13.5, height: 8, period: 48, front: 0.3, rows: 1 },
  }),
  preset("dark", {
    id: "p7",
    name: "Desert Oak",
    colors: ["#35302a", "#6b5b46", "#423b33"],
    backing: "#12100e",
    speed: 0.9,
    params: { count: 200, radius: 14, height: 7, period: 56, front: 0.35, rows: 2 },
  }),
  preset("dark", {
    id: "p8",
    name: "Bloodwood",
    colors: ["#2f2224", "#744d44", "#3b2e2e"],
    backing: "#130d0e",
    speed: 1.1,
    params: {
      count: 140,
      radius: 13,
      height: 8.5,
      period: 42,
      front: 0.25,
      rows: 1,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Kurrajong",
    colors: ["#22302c", "#4f6655", "#2d3a36"],
    backing: "#0c1311",
    speed: 0.8,
    params: { count: 240, radius: 15.5, height: 9, period: 80, front: 0.5, rows: 4 },
  }),
];
