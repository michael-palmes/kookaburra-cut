import { stageSpot, TEXT_CALM_PARAM } from "../../kit";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { PlexusLoom } from "./PlexusLoom";

export const look: Scene3dBackgroundDef = {
  id: "plexus-loom",
  name: "Plexus loom",
  family: "lines",
  colorSlots: [
    { label: "Thread A", fallback: "#5b4d6d" },
    { label: "Thread B", fallback: "#45616f" },
    { label: "Thread C", fallback: "#6b5c3b" },
    { label: "Hoop", fallback: "#ad8d58", glow: true },
  ],
  params: {
    bundles: { label: "Bundles", default: 36, min: 18, max: 48, step: 1 },
    hoopRadius: { label: "Hoop radius", default: 16, min: 13, max: 22, step: 0.5 },
    twist: { label: "Twist", default: 80, min: 50, max: 98, step: 1 },
    breath: { label: "Breathing", default: 12, min: 0, max: 18, step: 0.5 },
    spin: { label: "Spin speed", default: 1, min: 0, max: 3, step: 0.05 },
    opacity: { label: "Thread opacity", default: 0.55, min: 0.3, max: 0.9, step: 0.01 },
    textCalm: { ...TEXT_CALM_PARAM, default: 0.6 },
  },
  Component: PlexusLoom,
};

/** Matching rig: a warm key down from the high hoop and a faint rim up from the low hoop in the Hoop colour. No hoop fixtures: they would draw unfaded across the stage on a dolly out (F11). */
function loomLighting(mode: "light" | "dark", hoop: string): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: {
      source: dark ? "kookaburra:night-city" : "kookaburra:ferndale-studio",
      intensity: dark ? 0.4 : 0.9,
      rotationDeg: 0,
    },
    sun: { azimuthDeg: 25, elevationDeg: 75, intensity: dark ? 1.5 : 2, kelvin: 3400 },
    ambient: dark ? 0.12 : 0.35,
    lights: [
      stageSpot("bg3d-loom-rim", {
        azimuthDeg: 180,
        elevationDeg: -30,
        distance: 9,
        irradiance: dark ? 0.5 : 0.35,
        coneDeg: 45,
        color: hoop,
      }),
    ],
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: loomLighting(mode, p.colors[3]),
});

export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Queenscliff",
    colors: ["#a794b8", "#94abbe", "#cdbd9b", "#c2a36c"],
    backing: "#f7f5f9",
    speed: 1,
    params: {
      bundles: 36,
      hoopRadius: 16,
      twist: 80,
      breath: 12,
      spin: 1,
      opacity: 0.55,
      textCalm: 0.6,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Point Lonsdale",
    colors: ["#8fb3ad", "#a9b79c", "#c9b99a", "#b49667"],
    backing: "#f3f6f4",
    speed: 1,
    params: {
      bundles: 44,
      hoopRadius: 17,
      twist: 72,
      breath: 9,
      spin: 0.8,
      opacity: 0.5,
      textCalm: 0.6,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Aireys Inlet",
    colors: ["#c99a8f", "#d0ab86", "#a9a0b8", "#c48e7a"],
    backing: "#f8f3ef",
    speed: 1,
    params: {
      bundles: 30,
      hoopRadius: 15,
      twist: 90,
      breath: 14,
      spin: 1.2,
      opacity: 0.6,
      textCalm: 0.65,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Port Fairy",
    colors: ["#8b9daf", "#a3b3a4", "#b8b0a2", "#b99d73"],
    backing: "#f1f4f6",
    speed: 0.9,
    params: {
      bundles: 24,
      hoopRadius: 18,
      twist: 64,
      breath: 16,
      spin: 1.4,
      opacity: 0.7,
      textCalm: 0.65,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Cape Schanck",
    colors: ["#a8b08f", "#b3a4bd", "#9fb0b3", "#bb9473"],
    backing: "#f4f5ef",
    speed: 1.1,
    params: {
      bundles: 40,
      hoopRadius: 16.5,
      twist: 86,
      breath: 10,
      spin: 0.6,
      opacity: 0.45,
      textCalm: 0.55,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Hanging Rock",
    colors: ["#5b4d6d", "#45616f", "#6b5c3b", "#ad8d58"],
    backing: "#0f0d13",
    speed: 1,
    params: {
      bundles: 36,
      hoopRadius: 16,
      twist: 80,
      breath: 12,
      spin: 1,
      opacity: 0.55,
      textCalm: 0.6,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Loch Ard",
    colors: ["#3c5a73", "#2f6068", "#5a5670", "#9f9271"],
    backing: "#0a0e14",
    speed: 1,
    params: {
      bundles: 42,
      hoopRadius: 17,
      twist: 76,
      breath: 12,
      spin: 0.8,
      opacity: 0.6,
      textCalm: 0.6,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Tidal River",
    colors: ["#6a4c3a", "#5c4b62", "#4f5a5e", "#bd885c"],
    backing: "#110d0b",
    speed: 0.9,
    params: {
      bundles: 28,
      hoopRadius: 15,
      twist: 92,
      breath: 15,
      spin: 1.3,
      opacity: 0.65,
      textCalm: 0.65,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Mallacoota",
    colors: ["#4c6152", "#454e72", "#634d66", "#8c92a8"],
    backing: "#0b0e0d",
    speed: 1.1,
    params: {
      bundles: 48,
      hoopRadius: 19,
      twist: 68,
      breath: 8,
      spin: 0.7,
      opacity: 0.5,
      textCalm: 0.55,
    },
  }),
];
