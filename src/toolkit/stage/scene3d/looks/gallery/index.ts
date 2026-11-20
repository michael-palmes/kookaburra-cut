import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { BAY_RANGE, LAMP_HEIGHT_RANGE, PIER_DEPTH_RANGE } from "./bays";
import { Gallery } from "./Gallery";

/** Gallery (deco): a warm top-lit gallery behind the stage, clear plaster bays between shallow piers, each under a brass picture light, oak boards and a leafy clerestory. Bays centre on x = k * bay width, so a scene hangs its works there, just in front of the wall at z -7.5. */
export const look: Scene3dBackgroundDef = {
  id: "gallery",
  name: "Gallery",
  family: "deco",
  colorSlots: [
    { label: "Plaster", fallback: "#3b3530" },
    { label: "Oak", fallback: "#4a2f22" },
    { label: "Shade", fallback: "#15120f" },
    { label: "Brass", fallback: "#705c3b" },
    { label: "Lamp", fallback: "#a8895c", glow: true },
  ],
  params: {
    bayWidth: { label: "Bay width", default: 9, ...BAY_RANGE, step: 0.5 },
    pierDepth: { label: "Pier depth", default: 0.6, ...PIER_DEPTH_RANGE, step: 0.05 },
    lampHeight: { label: "Lamp height", default: 2.6, ...LAMP_HEIGHT_RANGE, step: 0.1 },
    pools: { label: "Picture lights", default: 0.85, min: 0, max: 1, step: 0.01 },
    daylight: { label: "Daylight", default: 0.25, min: 0, max: 1, step: 0.01 },
    clouds: { label: "Passing cloud", default: 0.4, min: 0, max: 1, step: 0.01 },
    boards: { label: "Board width", default: 0.42, min: 0.25, max: 0.8, step: 0.01 },
  },
  previewCamera: "sweep",
  Component: Gallery,
};

/** Matching rig: a soft light from high in front, where the picture lights hang, over an interior environment, so devices and hung screens sit in the gallery's light. */
function galleryLighting(
  mode: "light" | "dark",
  kelvin: number,
  intensity: number,
): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:interior", intensity: dark ? 0.3 : 0.7, rotationDeg: 0 },
    sun: { azimuthDeg: 0, elevationDeg: 68, intensity, kelvin, angularDeg: 4 },
    ambient: dark ? 0.2 : 0.5,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting" | "params"> & {
  params: Record<string, number>;
  kelvin: number;
  intensity: number;
};

const preset = (
  mode: "light" | "dark",
  { kelvin, intensity, ...p }: Tune,
): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: galleryLighting(mode, kelvin, intensity),
});

/** Australian timbers: pale and botanical by day, deep country by night. Every preset keeps the bays at 9 so hung works stay in them across preset changes. p1 matches the Exhibition world. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Tasmanian Oak",
    colors: ["#c9bbb1", "#b49579", "#a99c94", "#bfa06e", "#ffe8c4"],
    backing: "#e2d8cd",
    speed: 1,
    kelvin: 3800,
    intensity: 1.8,
    params: {
      bayWidth: 9,
      pierDepth: 0.6,
      lampHeight: 2.6,
      pools: 1,
      daylight: 0.6,
      clouds: 0.5,
      boards: 0.42,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Celery Top",
    colors: ["#ddd3c3", "#c9a774", "#b3a690", "#c6a466", "#fff3d8"],
    backing: "#ece5d9",
    speed: 0.9,
    kelvin: 4400,
    intensity: 1.7,
    params: {
      bayWidth: 9,
      pierDepth: 0.45,
      lampHeight: 2.6,
      pools: 0.65,
      daylight: 0.8,
      clouds: 0.65,
      boards: 0.34,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Spotted Gum",
    colors: ["#c4c3bf", "#b0a593", "#a3a3a2", "#b9a073", "#f6f3ec"],
    backing: "#e1e0dd",
    speed: 1.1,
    kelvin: 5000,
    intensity: 1.6,
    params: {
      bayWidth: 9,
      pierDepth: 0.85,
      lampHeight: 2.6,
      pools: 0.8,
      daylight: 0.45,
      clouds: 0.35,
      boards: 0.55,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Blackbutt",
    colors: ["#bcc2b0", "#c4a988", "#a2a796", "#c3a46c", "#fbf3df"],
    backing: "#e3e6dc",
    speed: 1,
    kelvin: 4800,
    intensity: 1.7,
    params: {
      bayWidth: 9,
      pierDepth: 0.35,
      lampHeight: 2.6,
      pools: 0.55,
      daylight: 0.9,
      clouds: 0.75,
      boards: 0.65,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Silky Oak",
    colors: ["#d8c1b8", "#c49d86", "#b39d96", "#c09b70", "#ffeedd"],
    backing: "#eadcd6",
    speed: 0.85,
    kelvin: 3500,
    intensity: 1.8,
    params: {
      bayWidth: 9,
      pierDepth: 1,
      lampHeight: 2.6,
      pools: 1,
      daylight: 0.35,
      clouds: 0.4,
      boards: 0.46,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Rosewood",
    colors: ["#3b3530", "#4a2f22", "#15120f", "#705c3b", "#a8895c"],
    backing: "#110f0d",
    speed: 1,
    kelvin: 3000,
    intensity: 1.2,
    params: {
      bayWidth: 9,
      pierDepth: 0.6,
      lampHeight: 2.6,
      pools: 0.85,
      daylight: 0.25,
      clouds: 0.4,
      boards: 0.42,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Buloke",
    colors: ["#2f3540", "#3a2e26", "#111317", "#6c5839", "#a0875f"],
    backing: "#0d0f12",
    speed: 0.9,
    kelvin: 3400,
    intensity: 1.1,
    params: {
      bayWidth: 9,
      pierDepth: 0.8,
      lampHeight: 2.6,
      pools: 0.75,
      daylight: 0.35,
      clouds: 0.3,
      boards: 0.36,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Gidgee",
    colors: ["#2b322c", "#2f231b", "#0e110e", "#66523a", "#a5845a"],
    backing: "#0b0d0b",
    speed: 1.1,
    kelvin: 2800,
    intensity: 1,
    params: {
      bayWidth: 9,
      pierDepth: 0.4,
      lampHeight: 2.6,
      pools: 1,
      daylight: 0.15,
      clouds: 0.2,
      boards: 0.6,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Red Gum",
    colors: ["#42292a", "#4d2c22", "#170e0e", "#74583b", "#a78560"],
    backing: "#130c0c",
    speed: 0.95,
    kelvin: 3200,
    intensity: 1.15,
    params: {
      bayWidth: 9,
      pierDepth: 1,
      lampHeight: 2.6,
      pools: 0.9,
      daylight: 0.3,
      clouds: 0.5,
      boards: 0.5,
    },
  }),
];
