import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { AuroraVeil } from "./AuroraVeil";

/** Aurora veil (atmosphere): folded northern-lights curtains with ray striations and a crisp hem on a far ring, over a zenith tint dome. */
export const look: Scene3dBackgroundDef = {
  id: "aurora-veil",
  name: "Aurora veil",
  family: "atmosphere",
  colorSlots: [
    { label: "Hem", fallback: "#2d6a55" },
    { label: "Crown", fallback: "#633c6f" },
    { label: "Sky tint", fallback: "#121a29" },
  ],
  params: {
    curtains: { label: "Curtains", default: 5, min: 3, max: 5, step: 1 },
    radius: { label: "Distance", default: 46, min: 36, max: 60, step: 1 },
    hemHeight: { label: "Hem height", default: 3.6, min: 1, max: 8, step: 0.1 },
    fold: { label: "Fold depth", default: 5.5, min: 0, max: 8, step: 0.1 },
    rays: { label: "Ray density", default: 1, min: 0.5, max: 2, step: 0.05 },
    brightness: { label: "Brightness", default: 0.8, min: 0.3, max: 1, step: 0.01 },
  },
  previewCamera: "ceiling",
  Component: AuroraVeil,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
});

/** Top End coast and islands. Light presets lay pastel veils over a pale sky; dark presets add light over a night sky. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Mindil Beach",
    colors: ["#9ac9b9", "#baa1c6", "#829cb5"],
    backing: "#eff2f5",
    speed: 1,
    params: {
      curtains: 5,
      radius: 46,
      hemHeight: 3.6,
      fold: 5.5,
      rays: 1,
      brightness: 0.8,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Lee Point",
    colors: ["#8fbf98", "#c99aa6", "#869bb6"],
    backing: "#f3f1ee",
    speed: 0.8,
    params: {
      curtains: 4,
      radius: 50,
      hemHeight: 4.2,
      fold: 4,
      rays: 0.8,
      brightness: 0.9,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Dundee Beach",
    colors: ["#7fb6b9", "#9d93c0", "#869cae"],
    backing: "#edf1f2",
    speed: 1.1,
    params: {
      curtains: 5,
      radius: 42,
      hemHeight: 3,
      fold: 7,
      rays: 1.4,
      brightness: 0.95,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Bynoe Harbour",
    colors: ["#a596c6", "#c895aa", "#8e98b8"],
    backing: "#f1eff5",
    speed: 0.9,
    params: {
      curtains: 4,
      radius: 54,
      hemHeight: 5,
      fold: 6.5,
      rays: 1.2,
      brightness: 0.9,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Cape Arnhem",
    colors: ["#80b8a2", "#c4ae84", "#879ca5"],
    backing: "#f2f2ec",
    speed: 1.2,
    params: {
      curtains: 5,
      radius: 46,
      hemHeight: 2.8,
      fold: 3,
      rays: 0.7,
      brightness: 0.95,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Barkly Night",
    colors: ["#2d6a55", "#633c6f", "#121a29"],
    backing: "#0f1422",
    speed: 1,
    params: {
      curtains: 5,
      radius: 46,
      hemHeight: 3.6,
      fold: 5.5,
      rays: 1,
      brightness: 0.8,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Nightcliff",
    colors: ["#2d6a48", "#3f5a6e", "#101a24"],
    backing: "#0d1219",
    speed: 1.1,
    params: {
      curtains: 5,
      radius: 44,
      hemHeight: 3.2,
      fold: 6.5,
      rays: 1.3,
      brightness: 0.85,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Wessel Islands",
    colors: ["#625085", "#6e3c55", "#171427"],
    backing: "#0f0d1a",
    speed: 0.85,
    params: {
      curtains: 4,
      radius: 52,
      hemHeight: 4.5,
      fold: 4.5,
      rays: 0.8,
      brightness: 0.75,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Port Essington",
    colors: ["#286660", "#6a4a3a", "#111c22"],
    backing: "#0c1316",
    speed: 1,
    params: {
      curtains: 3,
      radius: 40,
      hemHeight: 2.6,
      fold: 7.5,
      rays: 1.6,
      brightness: 0.7,
    },
  }),
];
