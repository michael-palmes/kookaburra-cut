import { stageSpot } from "../../kit/companion";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { FrostedPanes } from "./FrostedPanes";
import { FROSTED, frostedLayout } from "./panes";

/** Frosted panes (atmosphere): shoji screens and acid-etched glass in a ring, lamps glowing through the frost the way BigWings' Heartfelt fogs a window. */
export const look: Scene3dBackgroundDef = {
  id: "frosted-panes",
  name: "Frosted panes",
  family: "atmosphere",
  colorSlots: [
    { label: "Glass", fallback: "#161e25" },
    { label: "Frame", fallback: "#2b3740" },
    { label: "Bloom", fallback: "#835838" },
    { label: "Lamp", fallback: "#b58a5e", glow: true },
  ],
  params: {
    paneCount: { label: "Panes", default: 22, min: 10, max: FROSTED.maxPanes, step: 1 },
    ringRadius: { label: "Ring radius", default: 12.5, min: 10, max: 18, step: 0.5 },
    lampCount: { label: "Lamps", default: 5, min: 1, max: FROSTED.maxLamps, step: 1 },
    bloom: { label: "Bloom", default: 0.8, min: 0.2, max: 1, step: 0.01 },
    frost: { label: "Frost", default: 0.5, min: 0, max: 1, step: 0.01 },
    rain: { label: "Rain", default: 0, min: 0, max: 1, step: 0.01 },
  },
  Component: FrostedPanes,
};

const DEG = 180 / Math.PI;
const COMPANION_LAMPS = 2;

/** Orbit seats (v9 convention) of up to two lamps whose mean seats sit behind the stage, furthest first, so the companion rims come from where the blooms glow. */
export function frostedRimSeats(
  params: Record<string, number>,
): { azimuthDeg: number; elevationDeg: number; distance: number }[] {
  const { lamps } = frostedLayout(params.paneCount, params.lampCount, params.ringRadius);
  const r = params.ringRadius + FROSTED.lampOffset;
  return lamps
    .map((l) => ({ x: Math.cos(l.angle) * r, z: Math.sin(l.angle) * r }))
    .filter((seat) => seat.z < -r * 0.2)
    .sort((a, b) => a.z - b.z)
    .slice(0, COMPANION_LAMPS)
    .map(({ x, z }) => ({
      azimuthDeg: Math.round(Math.atan2(x, z) * DEG),
      elevationDeg: Math.round(Math.atan2(FROSTED.lampY, r) * DEG),
      distance: Math.round(Math.hypot(r, FROSTED.lampY) * 10) / 10,
    }));
}

/** Matching rig: soft daylight through the frost (a diffuse environment and a gentle high key) plus warm rims from the lamps furthest behind the stage, at their mean seats (companion blocks are static), tinted by the Lamp slot. */
function companion(
  mode: "light" | "dark",
  lamp: string,
  params: Record<string, number>,
): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:softbox", intensity: dark ? 0.35 : 0.8, rotationDeg: 0 },
    sun: {
      azimuthDeg: 20,
      elevationDeg: 40,
      intensity: dark ? 0.6 : 1.2,
      kelvin: dark ? 4200 : 5600,
    },
    ambient: dark ? 0.15 : 0.4,
    lights: frostedRimSeats(params).map((seat, i) =>
      stageSpot(`bg3d-frost-lamp-${i + 1}`, {
        ...seat,
        irradiance: dark ? 0.6 : 0.4,
        coneDeg: 40,
        color: lamp,
      }),
    ),
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting"> & {
  params: Record<string, number>;
};

const preset = (mode: "light" | "dark", p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: companion(mode, p.colors[3], p.params),
});

/** Queensland hinterland and outback town names. p1 and p6 are the approved sketch palettes (p1's frame lifted to the 0.315 Theme floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", {
    id: "p1",
    name: "Maleny",
    colors: ["#c9d3d9", "#8a9da9", "#f8e3cb", "#fff8ef"],
    backing: "#afbcc4",
    speed: 1,
    params: {
      paneCount: 22,
      ringRadius: 12.5,
      lampCount: 5,
      bloom: 0.8,
      frost: 0.5,
      rain: 0,
    },
  }),
  preset("light", {
    id: "p2",
    name: "Montville",
    colors: ["#ddd5c8", "#a59785", "#f6e6cf", "#fff9ef"],
    backing: "#c3b9ab",
    speed: 0.9,
    params: {
      paneCount: 18,
      ringRadius: 13.5,
      lampCount: 4,
      bloom: 0.7,
      frost: 0.7,
      rain: 0,
    },
  }),
  preset("light", {
    id: "p3",
    name: "Kenilworth",
    colors: ["#cdd6cc", "#8e9e8e", "#f1ead0", "#fbf9ee"],
    backing: "#b3bfb2",
    speed: 1.1,
    params: {
      paneCount: 26,
      ringRadius: 12,
      lampCount: 6,
      bloom: 0.65,
      frost: 0.35,
      rain: 0,
    },
  }),
  preset("light", {
    id: "p4",
    name: "Mapleton",
    colors: ["#d3d0dc", "#9993aa", "#f5e3d8", "#fdf7f3"],
    backing: "#bab6c6",
    speed: 0.85,
    params: {
      paneCount: 14,
      ringRadius: 14.5,
      lampCount: 3,
      bloom: 0.9,
      frost: 0.6,
      rain: 0,
    },
  }),
  preset("light", {
    id: "p5",
    name: "Eumundi",
    colors: ["#e0d4cc", "#ac9388", "#f8e1c6", "#fff7ea"],
    backing: "#c9b8ae",
    speed: 1,
    params: {
      paneCount: 30,
      ringRadius: 11.5,
      lampCount: 7,
      bloom: 0.6,
      frost: 0.45,
      rain: 0,
    },
  }),
  preset("dark", {
    id: "p6",
    name: "Winton",
    colors: ["#161e25", "#2b3740", "#835838", "#b58a5e"],
    backing: "#1a232c",
    speed: 1,
    params: {
      paneCount: 22,
      ringRadius: 12.5,
      lampCount: 5,
      bloom: 0.8,
      frost: 0.5,
      rain: 0,
    },
  }),
  preset("dark", {
    id: "p7",
    name: "Barcaldine",
    colors: ["#14201d", "#2a3a35", "#785c33", "#ad8d55"],
    backing: "#17231f",
    speed: 0.9,
    params: {
      paneCount: 16,
      ringRadius: 13,
      lampCount: 4,
      bloom: 0.85,
      frost: 0.65,
      rain: 0,
    },
  }),
  preset("dark", {
    id: "p8",
    name: "Boulia",
    colors: ["#211714", "#3d2c26", "#86503a", "#b98566"],
    backing: "#24191a",
    speed: 1.1,
    params: {
      paneCount: 28,
      ringRadius: 12,
      lampCount: 6,
      bloom: 0.7,
      frost: 0.4,
      rain: 0,
    },
  }),
  preset("dark", {
    id: "p9",
    name: "Quilpie",
    colors: ["#171a29", "#2d3247", "#5f5a7e", "#938dba"],
    backing: "#1a1d2e",
    speed: 0.8,
    params: {
      paneCount: 20,
      ringRadius: 15,
      lampCount: 3,
      bloom: 0.95,
      frost: 0.8,
      rain: 0,
    },
  }),
];
