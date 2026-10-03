import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { MEZZO_LAND } from "./land";
import { MezzotintSky } from "./MezzotintSky";

/** Mezzotint sky (atmosphere): a dusk mezzotint under a world-fixed burr, burnished cloud banks and a glow band on a far dome over a smooth haze band, with rocked land ridges and valley mist at real depth below. */
export const look: Scene3dBackgroundDef = {
  id: "mezzotint-sky",
  name: "Mezzotint sky",
  family: "atmosphere",
  colorSlots: [
    { label: "Ground", fallback: "#171522" },
    { label: "Burnish", fallback: "#715f44" },
  ],
  params: {
    grain: { label: "Grain size", default: 4, min: 2, max: 8, step: 0.1 },
    cloud: { label: "Cloud cover", default: 0.5, min: 0, max: 1, step: 0.01 },
    glow: { label: "Horizon glow", default: 0.7, min: 0, max: 1, step: 0.01 },
    cap: { label: "Highlight cap", default: 0.82, min: 0.6, max: 0.95, step: 0.01 },
    drift: { label: "Drift period", default: 240, min: 120, max: 600, step: 10 },
    relief: { label: "Land relief", default: 1, min: 0.4, max: MEZZO_LAND.reliefMax, step: 0.01 },
    mist: { label: "Valley mist", default: 0.5, min: 0, max: 1, step: 0.01 },
  },
  previewCamera: "ceiling",
  Component: MezzotintSky,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor">;

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
});

/** Red Centre dusks. The backing sets the plate's mean tone between Ground and Burnish: pale backings print a burnished dawn, dark ones a rocked night. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Mount Sonder",
    colors: ["#9f94b5", "#f7f4ef"],
    backing: "#cccad8",
    speed: 1,
    params: {
      grain: 4,
      cloud: 0.5,
      glow: 0.7,
      cap: 0.82,
      drift: 240,
      relief: 1,
      mist: 0.5,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Ewaninga",
    colors: ["#a8957f", "#f6efe2"],
    backing: "#c9bcad",
    speed: 1,
    params: {
      grain: 5,
      cloud: 0.65,
      glow: 0.55,
      cap: 0.78,
      drift: 200,
      relief: 0.8,
      mist: 0.3,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Tylers Pass",
    colors: ["#899aac", "#f2f1ea"],
    backing: "#c9cfd3",
    speed: 1,
    params: {
      grain: 3,
      cloud: 0.4,
      glow: 0.85,
      cap: 0.88,
      drift: 300,
      relief: 1.3,
      mist: 0.65,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Emily Gap",
    colors: ["#b39089", "#f7ede6"],
    backing: "#dcc9c2",
    speed: 1.1,
    params: {
      grain: 6,
      cloud: 0.55,
      glow: 0.75,
      cap: 0.85,
      drift: 240,
      relief: 1.15,
      mist: 0.45,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Jessie Gap",
    colors: ["#919c8c", "#f1f0e6"],
    backing: "#d5d8cc",
    speed: 0.9,
    params: {
      grain: 3.5,
      cloud: 0.3,
      glow: 0.6,
      cap: 0.8,
      drift: 180,
      relief: 0.6,
      mist: 0.75,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Rainbow Valley",
    colors: ["#171522", "#715f44"],
    backing: "#201d31",
    speed: 1,
    params: {
      grain: 4,
      cloud: 0.5,
      glow: 0.7,
      cap: 0.82,
      drift: 240,
      relief: 1,
      mist: 0.5,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Mount Conner",
    colors: ["#10161e", "#58636c"],
    backing: "#1c2632",
    speed: 1,
    params: {
      grain: 3,
      cloud: 0.6,
      glow: 0.6,
      cap: 0.85,
      drift: 300,
      relief: 1.4,
      mist: 0.35,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Haasts Bluff",
    colors: ["#1c1312", "#74503e"],
    backing: "#2a1e1b",
    speed: 1.1,
    params: {
      grain: 5,
      cloud: 0.45,
      glow: 0.9,
      cap: 0.8,
      drift: 200,
      relief: 1.2,
      mist: 0.25,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Arltunga",
    colors: ["#141712", "#626448"],
    backing: "#262b22",
    speed: 0.9,
    params: {
      grain: 6,
      cloud: 0.7,
      glow: 0.5,
      cap: 0.9,
      drift: 300,
      relief: 0.7,
      mist: 0.8,
    },
  }),
];
