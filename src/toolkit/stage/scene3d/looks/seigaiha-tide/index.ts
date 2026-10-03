import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { SeigaihaTide } from "./SeigaihaTide";

export const look: Scene3dBackgroundDef = {
  id: "seigaiha-tide",
  name: "Seigaiha tide",
  family: "history",
  colorSlots: [
    { label: "Prussian", fallback: "#16263d" },
    { label: "Wave", fallback: "#2c3f55" },
    { label: "Dawn", fallback: "#4a3530" },
    { label: "Foam", fallback: "#4f6377" },
  ],
  params: {
    fans: { label: "Fans per row", default: 10, min: 6, max: 16, step: 1 },
    rings: { label: "Rings per fan", default: 4, min: 3, max: 5, step: 1 },
    clearRadius: { label: "Clearing", default: 3, min: 1.5, max: 8, step: 0.1 },
    swell: { label: "Swell height", default: 0.45, min: 0, max: 0.9, step: 0.01 },
    swellSpeed: { label: "Swell speed", default: 1, min: 0, max: 2, step: 0.05 },
    ripple: { label: "Fan ripple", default: 0.34, min: 0, max: 0.6, step: 0.01 },
    mist: { label: "Horizon mist", default: 7.5, min: 2, max: 12, step: 0.1 },
  },
  previewCamera: "sweep",
  Component: SeigaihaTide,
};

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "params"> & {
  params: Record<
    "fans" | "rings" | "clearRadius" | "swell" | "swellSpeed" | "ripple" | "mist",
    number
  >;
};

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
});

/** South Australian coast. Slots print the woodblock plates: Prussian key and band, Wave fill, Dawn sky band, Foam key line and swell light. */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Encounter Bay",
    colors: ["#869bb5", "#a9b8c9", "#e6c9b4", "#f4f1ea"],
    backing: "#efe8da",
    speed: 1,
    params: {
      fans: 10,
      rings: 4,
      clearRadius: 3,
      swell: 0.45,
      swellSpeed: 1,
      ripple: 0.34,
      mist: 7.5,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Waitpinga",
    colors: ["#799da7", "#a7c3c6", "#e7d3b2", "#f2f3ec"],
    backing: "#eef0e8",
    speed: 1,
    params: {
      fans: 14,
      rings: 5,
      clearRadius: 2.5,
      swell: 0.65,
      swellSpeed: 1.3,
      ripple: 0.45,
      mist: 6,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Port Elliot",
    colors: ["#8c95b8", "#b7bdd2", "#e8c7c3", "#f5f1ee"],
    backing: "#f1ebe8",
    speed: 0.9,
    params: {
      fans: 8,
      rings: 3,
      clearRadius: 4,
      swell: 0.35,
      swellSpeed: 0.8,
      ripple: 0.25,
      mist: 9,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Petrel Cove",
    colors: ["#869f96", "#b4c5bb", "#e9d9b8", "#f3f2e8"],
    backing: "#efeee2",
    speed: 1.1,
    params: {
      fans: 12,
      rings: 4,
      clearRadius: 3.5,
      swell: 0.55,
      swellSpeed: 1.1,
      ripple: 0.5,
      mist: 7,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Middleton",
    colors: ["#8399b2", "#adc1cf", "#efd2a8", "#f6f3e9"],
    backing: "#f3eee1",
    speed: 0.9,
    params: {
      fans: 16,
      rings: 5,
      clearRadius: 2,
      swell: 0.3,
      swellSpeed: 0.9,
      ripple: 0.2,
      mist: 10,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Coorong",
    colors: ["#16263d", "#2c3f55", "#4a3530", "#4f6377"],
    backing: "#0d1522",
    speed: 1,
    params: {
      fans: 10,
      rings: 4,
      clearRadius: 3,
      swell: 0.45,
      swellSpeed: 1,
      ripple: 0.34,
      mist: 7.5,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Rapid Bay",
    colors: ["#11292f", "#234249", "#4b3b2c", "#4a6669"],
    backing: "#0a1618",
    speed: 1,
    params: {
      fans: 13,
      rings: 5,
      clearRadius: 2.5,
      swell: 0.6,
      swellSpeed: 1.2,
      ripple: 0.42,
      mist: 6.5,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Cape Jervis",
    colors: ["#1b1f3e", "#303558", "#523b46", "#5a5e7e"],
    backing: "#0f1125",
    speed: 0.9,
    params: {
      fans: 8,
      rings: 3,
      clearRadius: 4.5,
      swell: 0.35,
      swellSpeed: 0.8,
      ripple: 0.28,
      mist: 9,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Hanson Bay",
    colors: ["#1a2b2a", "#2e4140", "#473d2d", "#51655f"],
    backing: "#0f1a19",
    speed: 1.1,
    params: {
      fans: 11,
      rings: 4,
      clearRadius: 3.5,
      swell: 0.5,
      swellSpeed: 1.4,
      ripple: 0.5,
      mist: 8,
    },
  }),
];
