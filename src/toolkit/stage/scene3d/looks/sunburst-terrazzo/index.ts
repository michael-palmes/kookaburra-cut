import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { SunburstTerrazzo } from "./SunburstTerrazzo";

/** Sunburst terrazzo (deco): an inlaid deco floor medallion of two-tone wedge rays, stepped brass rings and a chevron border, with an optional counter-turning ceiling medallion. */
export const look: Scene3dBackgroundDef = {
  id: "sunburst-terrazzo",
  name: "Sunburst terrazzo",
  family: "deco",
  colorSlots: [
    { label: "Ray A", fallback: "#26344a" },
    { label: "Ray B", fallback: "#2e2a3c" },
    { label: "Brass inlay", fallback: "#6a5a36" },
  ],
  params: {
    rays: { label: "Rays", default: 28, min: 16, max: 40, step: 2 },
    clearRadius: { label: "Plain disc", default: 5, min: 3.5, max: 8, step: 0.25 },
    turnMinutes: { label: "Turn (min)", default: 4, min: 2, max: 12, step: 0.5 },
    glint: { label: "Glint", default: 0.6, min: 0, max: 1, step: 0.05 },
    chips: { label: "Chips", default: 0.5, min: 0, max: 1, step: 0.05 },
    fadeRadius: { label: "Fade radius", default: 45, min: 25, max: 60, step: 1 },
    ceiling: { label: "Ceiling medallion", default: 1, min: 0, max: 1, step: 0.05 },
  },
  Component: SunburstTerrazzo,
};

type Mode = "light" | "dark";

const preset = (
  id: string,
  name: string,
  mode: Mode,
  colors: string[],
  backing: string,
  speed: number,
  params: Record<string, number>,
): Scene3dBackgroundPreset => ({
  id,
  name,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  colors,
  backing,
  speed,
  params,
});

/** Western Australian wheatbelt and goldfields names. p1 and p6 are the approved sketch palettes (p1's brass lifted to the 0.315 floor; the sketch's Pilbara name gave way to Gwalia). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("p1", "Lucky Bay", "light", ["#e2cfae", "#cbd9cc", "#ae9867"], "#f7f2e7", 1, {
    rays: 28,
    clearRadius: 5,
    turnMinutes: 4,
    glint: 0.6,
    chips: 0.5,
    fadeRadius: 45,
    ceiling: 1,
  }),
  preset("p2", "New Norcia", "light", ["#e2bba3", "#ddd5c3", "#ab9561"], "#f6efe6", 0.9, {
    rays: 24,
    clearRadius: 6,
    turnMinutes: 5,
    glint: 0.5,
    chips: 0.7,
    fadeRadius: 50,
    ceiling: 1,
  }),
  preset("p3", "Dryandra", "light", ["#c8d4c2", "#d5cde0", "#a39566"], "#f3f2e9", 1, {
    rays: 36,
    clearRadius: 4.5,
    turnMinutes: 3,
    glint: 0.7,
    chips: 0.3,
    fadeRadius: 40,
    ceiling: 0.8,
  }),
  preset("p4", "Kellerberrin", "light", ["#e6d3a1", "#c4d2dc", "#ad955f"], "#f6f2e6", 1.1, {
    rays: 32,
    clearRadius: 5.5,
    turnMinutes: 6,
    glint: 0.4,
    chips: 0.6,
    fadeRadius: 55,
    ceiling: 1,
  }),
  preset("p5", "Hyden", "light", ["#e0c4c4", "#cfcfd2", "#a79466"], "#f5f0ee", 0.9, {
    rays: 20,
    clearRadius: 7,
    turnMinutes: 8,
    glint: 0.8,
    chips: 0.4,
    fadeRadius: 38,
    ceiling: 0.75,
  }),
  preset("p6", "Gwalia", "dark", ["#26344a", "#2e2a3c", "#6a5a36"], "#0b0f16", 1, {
    rays: 28,
    clearRadius: 5,
    turnMinutes: 4,
    glint: 0.6,
    chips: 0.5,
    fadeRadius: 45,
    ceiling: 1,
  }),
  preset("p7", "Coolgardie", "dark", ["#4a2e2a", "#34302a", "#6b5534"], "#110c0b", 1, {
    rays: 20,
    clearRadius: 6,
    turnMinutes: 5,
    glint: 0.7,
    chips: 0.6,
    fadeRadius: 48,
    ceiling: 1,
  }),
  preset("p8", "Lake Ballard", "dark", ["#3b3a4c", "#2f3f45", "#5f5a48"], "#0c1012", 0.9, {
    rays: 36,
    clearRadius: 4,
    turnMinutes: 3,
    glint: 0.5,
    chips: 0.3,
    fadeRadius: 42,
    ceiling: 0.8,
  }),
  preset("p9", "Norseman", "dark", ["#1f3a35", "#3a3424", "#6a5a3a"], "#0a100f", 1.1, {
    rays: 32,
    clearRadius: 5.5,
    turnMinutes: 6,
    glint: 0.8,
    chips: 0.5,
    fadeRadius: 52,
    ceiling: 1,
  }),
];
