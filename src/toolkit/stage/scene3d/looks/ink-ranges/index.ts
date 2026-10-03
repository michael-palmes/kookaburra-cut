import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { InkRanges } from "./InkRanges";
import { inkLighting } from "./ranges";

export const look: Scene3dBackgroundDef = {
  id: "ink-ranges",
  name: "Ink ranges",
  family: "painted",
  colorSlots: [
    { label: "Near ridge", fallback: "#0c1413" },
    { label: "Far ridge", fallback: "#26332f" },
    { label: "Mist", fallback: "#4f605a" },
    { label: "Sun", fallback: "#9a927c", glow: true },
  ],
  params: {
    horizon: { label: "Horizon height", default: 1, min: 0.4, max: 1.4, step: 0.05 },
    hardness: { label: "Edge hardness", default: 0.3, min: 0, max: 1, step: 0.01 },
    mist: { label: "Mist depth", default: 0.6, min: 0, max: 1, step: 0.01 },
    layers: { label: "Ranges", default: 4, min: 2, max: 5, step: 1 },
    drift: { label: "Drift speed", default: 1, min: 0, max: 3, step: 0.05 },
    discSize: { label: "Disc size", default: 1, min: 0, max: 2, step: 0.05 },
    eyeHaze: { label: "Eye-level haze", default: 0.38, min: 0, max: 0.7, step: 0.01 },
  },
  Component: InkRanges,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting" | "params"> & {
  params: Record<string, number>;
};

/** A disc that shows carries the matching sun or moon rig; no disc, no rig. */
const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  ...(p.params.discSize > 0 ? { lighting: inkLighting(mode, p.params.horizon) } : {}),
});

export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Leura",
    colors: ["#8a9bac", "#a9b9c3", "#d3dcdc", "#dfa58c"],
    backing: "#f4f1ea",
    speed: 1,
    params: {
      horizon: 1,
      hardness: 0.15,
      mist: 0.6,
      layers: 4,
      drift: 1,
      discSize: 1,
      eyeHaze: 0.38,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Katoomba",
    colors: ["#7f9cb4", "#a4bccd", "#cfdce4", "#e5b38a"],
    backing: "#eef3f5",
    speed: 0.9,
    params: {
      horizon: 1.2,
      hardness: 0.55,
      mist: 0.45,
      layers: 5,
      drift: 0.8,
      discSize: 0.75,
      eyeHaze: 0.3,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Megalong",
    colors: ["#8b9d8a", "#b0bfa9", "#d8dfd0", "#d9c38f"],
    backing: "#f2f2e8",
    speed: 1.1,
    params: {
      horizon: 0.8,
      hardness: 0.05,
      mist: 0.85,
      layers: 3,
      drift: 1.2,
      discSize: 0,
      eyeHaze: 0.45,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Kanimbla",
    colors: ["#aa947d", "#c4b19a", "#e3d6c3", "#e59a6f"],
    backing: "#f7efe4",
    speed: 1,
    params: {
      horizon: 1.1,
      hardness: 0.4,
      mist: 0.5,
      layers: 4,
      drift: 1.3,
      discSize: 1.3,
      eyeHaze: 0.35,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Blackheath",
    colors: ["#9a93ad", "#b8b0c6", "#dcd6e2", "#e3a79a"],
    backing: "#f6f2f4",
    speed: 0.85,
    params: {
      horizon: 1.3,
      hardness: 1,
      mist: 0.35,
      layers: 5,
      drift: 0.7,
      discSize: 0.6,
      eyeHaze: 0.4,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Wollemi",
    colors: ["#0c1413", "#26332f", "#4f605a", "#9a927c"],
    backing: "#111a19",
    speed: 1,
    params: {
      horizon: 1,
      hardness: 0.85,
      mist: 0.6,
      layers: 4,
      drift: 1,
      discSize: 1,
      eyeHaze: 0.38,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Kanangra",
    colors: ["#0a111c", "#1f2c40", "#45566d", "#8a96a4"],
    backing: "#0e1522",
    speed: 0.9,
    params: {
      horizon: 1.25,
      hardness: 0.25,
      mist: 0.45,
      layers: 5,
      drift: 0.8,
      discSize: 1.2,
      eyeHaze: 0.3,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Grose",
    colors: ["#150f0b", "#34261d", "#6b5646", "#b0835a"],
    backing: "#1a130f",
    speed: 1.1,
    params: {
      horizon: 0.85,
      hardness: 0.65,
      mist: 0.8,
      layers: 3,
      drift: 1.2,
      discSize: 0,
      eyeHaze: 0.45,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Capertee",
    colors: ["#110e18", "#2c2640", "#5b5272", "#a28d99"],
    backing: "#15121d",
    speed: 1.2,
    params: {
      horizon: 0.95,
      hardness: 0.45,
      mist: 0.7,
      layers: 2,
      drift: 1.5,
      discSize: 1.6,
      eyeHaze: 0.3,
    },
  }),
];
