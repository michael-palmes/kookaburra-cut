import { TEXT_CALM_PARAM } from "../../kit/stage";
import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { PulsarRidges } from "./PulsarRidges";

export const look: Scene3dBackgroundDef = {
  id: "pulsar-ridges",
  name: "Pulsar ridges",
  family: "lines",
  colorSlots: [
    { label: "Ridge", fallback: "#3b4759" },
    { label: "Crest", fallback: "#525f77" },
    { label: "Skirt", fallback: "#141a24" },
  ],
  params: {
    rings: { label: "Rings", default: 34, min: 16, max: 48, step: 1 },
    valley: { label: "Valley radius", default: 12, min: 8, max: 20, step: 0.5 },
    height: { label: "Peak height", default: 1, min: 0.3, max: 1.6, step: 0.05 },
    massifs: { label: "Massifs", default: 4, min: 1, max: 6, step: 1 },
    lineWidth: { label: "Line width", default: 2.2, min: 1, max: 4, step: 0.1 },
    drift: { label: "Drift speed", default: 1, min: 0, max: 3, step: 0.05 },
    textCalm: { ...TEXT_CALM_PARAM, default: 0.5 },
  },
  Component: PulsarRidges,
};

const light = (
  id: string,
  name: string,
  colors: string[],
  backing: string,
  params: Record<string, number>,
): Scene3dBackgroundPreset => ({
  id,
  name,
  mode: "light",
  textColor: "#000000",
  colors,
  backing,
  speed: 1,
  params,
});

const dark = (
  id: string,
  name: string,
  colors: string[],
  backing: string,
  params: Record<string, number>,
): Scene3dBackgroundPreset => ({
  id,
  name,
  mode: "dark",
  textColor: "#ffffff",
  colors,
  backing,
  speed: 1,
  params,
});

export const presets: Scene3dBackgroundPreset[] = [
  light("p1", "Hattah Lakes", ["#a7b3c2", "#8e9bae", "#e3e8ee"], "#f3f5f8", {
    rings: 34,
    valley: 12,
    height: 1,
    massifs: 4,
    lineWidth: 2.2,
    drift: 1,
    textCalm: 0.5,
  }),
  light("p2", "Wimmera", ["#c2b79f", "#a4987b", "#ece6d8"], "#f7f4ec", {
    rings: 28,
    valley: 13,
    height: 0.75,
    massifs: 5,
    lineWidth: 2.4,
    drift: 0.8,
    textCalm: 0.5,
  }),
  light("p3", "Pink Lakes", ["#c9aeb2", "#b0929a", "#f0e4e4"], "#f9f3f2", {
    rings: 44,
    valley: 11,
    height: 0.9,
    massifs: 3,
    lineWidth: 1.6,
    drift: 1.2,
    textCalm: 0.55,
  }),
  light("p4", "Little Desert", ["#aebaa6", "#929e89", "#e4eadf"], "#f4f6f0", {
    rings: 22,
    valley: 14,
    height: 1.2,
    massifs: 2,
    lineWidth: 3,
    drift: 0.9,
    textCalm: 0.5,
  }),
  light("p5", "Arapiles", ["#b4aebb", "#9b94a3", "#e8e5eb"], "#f5f4f6", {
    rings: 36,
    valley: 10,
    height: 1.35,
    massifs: 4,
    lineWidth: 2,
    drift: 1.1,
    textCalm: 0.6,
  }),
  dark("p6", "Lake Tyrrell", ["#3b4759", "#525f77", "#141a24"], "#0d1219", {
    rings: 34,
    valley: 12,
    height: 1,
    massifs: 4,
    lineWidth: 2.2,
    drift: 1,
    textCalm: 0.5,
  }),
  dark("p7", "Wyperfeld", ["#34463f", "#4a6057", "#111a17"], "#0b1210", {
    rings: 40,
    valley: 12,
    height: 0.8,
    massifs: 6,
    lineWidth: 2,
    drift: 0.9,
    textCalm: 0.5,
  }),
  dark("p8", "Wartook", ["#4f4336", "#6b5b48", "#1c1712"], "#120f0b", {
    rings: 26,
    valley: 15,
    height: 1.1,
    massifs: 3,
    lineWidth: 2.8,
    drift: 0.8,
    textCalm: 0.45,
  }),
  dark("p9", "Murray Sunset", ["#463c58", "#5f5377", "#191522"], "#100d16", {
    rings: 46,
    valley: 9.5,
    height: 1.25,
    massifs: 5,
    lineWidth: 1.8,
    drift: 1.3,
    textCalm: 0.55,
  }),
];
