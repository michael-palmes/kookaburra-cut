import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { PopUpTerrace } from "./PopUpTerrace";
import { terraceLighting } from "./terrace";

/** Pop-up terrace (painted): Chatani's origamic architecture, a street of 90 degree cut-and-fold card houses round the stage. */
export const look: Scene3dBackgroundDef = {
  id: "pop-up-terrace",
  name: "Pop-up terrace",
  family: "painted",
  colorSlots: [
    { label: "Card lit", fallback: "#686054" },
    { label: "Card shade", fallback: "#2d3042" },
    { label: "Crease", fallback: "#131420" },
  ],
  params: {
    radius: { label: "Ring radius", default: 12.5, min: 11, max: 18, step: 0.5 },
    units: { label: "Units", default: 12, min: 8, max: 20, step: 1 },
    height: { label: "Height", default: 1, min: 0.6, max: 1.4, step: 0.05 },
    wavePeriod: { label: "Wave period (s)", default: 80, min: 40, max: 240, step: 5 },
    crests: { label: "Crests", default: 3, min: 1, max: 5, step: 1 },
    openHold: { label: "Open hold", default: 0.25, min: 0, max: 0.6, step: 0.01 },
    sunAzimuth: { label: "Sun azimuth", default: 303, min: 0, max: 360, step: 1 },
    shadow: { label: "Shadow", default: 0.7, min: 0, max: 1, step: 0.01 },
  },
  Component: PopUpTerrace,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting" | "params"> & {
  params: Record<string, number>;
};

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: terraceLighting(mode, p.params.sunAzimuth),
});

/** Hobart and Launceston streets and suburbs. p1 and p6 are the approved sketch palettes, p1's shade and backing deepened so lit card reads against the backing. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Battery Point",
    colors: ["#f6f2eb", "#a6aeb6", "#a6988c"],
    backing: "#d6d0c6",
    speed: 1,
    params: {
      radius: 12.5,
      units: 12,
      height: 1,
      wavePeriod: 80,
      crests: 3,
      openHold: 0.25,
      sunAzimuth: 303,
      shadow: 0.7,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Arthur Circus",
    colors: ["#f7eedd", "#b8a891", "#a9937c"],
    backing: "#d9cfbf",
    speed: 0.9,
    params: {
      radius: 14,
      units: 14,
      height: 0.9,
      wavePeriod: 100,
      crests: 2,
      openHold: 0.35,
      sunAzimuth: 315,
      shadow: 0.8,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Hampden Road",
    colors: ["#eef1f2", "#a3aeb6", "#8f9aa3"],
    backing: "#cfd5d8",
    speed: 1.1,
    params: {
      radius: 11.5,
      units: 10,
      height: 1.2,
      wavePeriod: 70,
      crests: 3,
      openHold: 0.2,
      sunAzimuth: 290,
      shadow: 0.65,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Trevallyn",
    colors: ["#eff0e6", "#aab09a", "#969a84"],
    backing: "#d3d6c8",
    speed: 1,
    params: {
      radius: 16,
      units: 18,
      height: 0.8,
      wavePeriod: 120,
      crests: 4,
      openHold: 0.3,
      sunAzimuth: 300,
      shadow: 0.75,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Cimitiere Street",
    colors: ["#f5ebe8", "#bca59f", "#ab918b"],
    backing: "#dccdc8",
    speed: 1.2,
    params: {
      radius: 13,
      units: 12,
      height: 1.1,
      wavePeriod: 90,
      crests: 1,
      openHold: 0.45,
      sunAzimuth: 320,
      shadow: 0.6,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Salamanca",
    colors: ["#686054", "#2d3042", "#131420"],
    backing: "#1a1c28",
    speed: 1,
    params: {
      radius: 12.5,
      units: 12,
      height: 1,
      wavePeriod: 80,
      crests: 3,
      openHold: 0.25,
      sunAzimuth: 303,
      shadow: 0.7,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Kelly Steps",
    colors: ["#6e5f4a", "#34302b", "#171513"],
    backing: "#1d1a17",
    speed: 0.9,
    params: {
      radius: 13.5,
      units: 14,
      height: 1.15,
      wavePeriod: 90,
      crests: 2,
      openHold: 0.3,
      sunAzimuth: 310,
      shadow: 0.8,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Wapping",
    colors: ["#4f6366", "#243236", "#0e1517"],
    backing: "#141c1f",
    speed: 1.1,
    params: {
      radius: 15,
      units: 16,
      height: 0.9,
      wavePeriod: 70,
      crests: 4,
      openHold: 0.2,
      sunAzimuth: 295,
      shadow: 0.7,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Invermay",
    colors: ["#64566a", "#2f2838", "#141018"],
    backing: "#1b1620",
    speed: 1,
    params: {
      radius: 12,
      units: 10,
      height: 1.3,
      wavePeriod: 110,
      crests: 3,
      openHold: 0.4,
      sunAzimuth: 325,
      shadow: 0.65,
    },
  }),
];
