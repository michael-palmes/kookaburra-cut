import { TEXT_CALM_PARAM } from "../../kit";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { BlueAndGold } from "./BlueAndGold";
import { PAINTER_SUN_ORBIT } from "./paddock";

export const look: Scene3dBackgroundDef = {
  id: "blue-and-gold",
  name: "Blue and gold",
  family: "painted",
  colorSlots: [
    { label: "Gold", fallback: "#544421" },
    { label: "Straw", fallback: "#685c3d" },
    { label: "Shade", fallback: "#2a2a31" },
    { label: "Ridge", fallback: "#1c2638" },
  ],
  params: {
    density: { label: "Daub density", default: 1, min: 0.3, max: 1.5, step: 0.05 },
    daubSize: { label: "Daub size", default: 1, min: 0.6, max: 1.6, step: 0.05 },
    clearRadius: { label: "Clearing", default: 6.5, min: 5, max: 12, step: 0.1 },
    wind: { label: "Wind", default: 1, min: 0, max: 3, step: 0.05 },
    cloudShadow: { label: "Cloud shadow", default: 0.6, min: 0, max: 1, step: 0.01 },
    boilFps: { label: "Boil rate", default: 0, min: 0, max: 6, step: 1 },
    ridgeHeight: { label: "Ridge height", default: 1, min: 0.3, max: 1.6, step: 0.05 },
    textCalm: TEXT_CALM_PARAM,
  },
  Component: BlueAndGold,
};

/** The companion rig is a soft sun from the painter's sun bearing, so a device shades like the paddock: warm daylight for light stock, a dimmer late glow for dark. */
const painterSun = (mode: "light" | "dark"): Scene3dCompanionLighting => ({
  sun: {
    azimuthDeg: PAINTER_SUN_ORBIT.azimuthDeg,
    elevationDeg: PAINTER_SUN_ORBIT.elevationDeg,
    intensity: mode === "light" ? 1.8 : 1.1,
    kelvin: mode === "light" ? 4800 : 3600,
    angularDeg: 6,
  },
  ambient: mode === "light" ? 0.45 : 0.3,
});

type Tuning = Record<
  "density" | "daubSize" | "clearRadius" | "wind" | "cloudShadow" | "ridgeHeight",
  number
>;

const preset = (
  base: Pick<Scene3dBackgroundPreset, "id" | "name" | "mode" | "colors" | "backing" | "speed">,
  t: Tuning,
): Scene3dBackgroundPreset => ({
  ...base,
  textColor: base.mode === "light" ? "#000000" : "#ffffff",
  params: {
    density: t.density,
    daubSize: t.daubSize,
    clearRadius: t.clearRadius,
    wind: t.wind,
    cloudShadow: t.cloudShadow,
    boilFps: 0,
    ridgeHeight: t.ridgeHeight,
    textCalm: 0.6,
  },
  lighting: painterSun(base.mode),
});

export const presets: Scene3dBackgroundPreset[] = [
  preset(
    {
      id: "p1",
      name: "Hawkesbury",
      mode: "light",
      colors: ["#d9c38a", "#efe3bf", "#a9a4ab", "#8a9db3"],
      backing: "#f7f4ea",
      speed: 1,
    },
    { density: 1, daubSize: 1, clearRadius: 6.5, wind: 1, cloudShadow: 0.6, ridgeHeight: 1 },
  ),
  preset(
    {
      id: "p2",
      name: "Mudgee",
      mode: "light",
      colors: ["#dab48c", "#f1e2cc", "#afa2ae", "#9596bb"],
      backing: "#f9f4ee",
      speed: 0.9,
    },
    { density: 1.3, daubSize: 0.8, clearRadius: 6, wind: 0.7, cloudShadow: 0.45, ridgeHeight: 0.8 },
  ),
  preset(
    {
      id: "p3",
      name: "Brocklesby",
      mode: "light",
      colors: ["#dcc57c", "#f3eac6", "#a5aa9d", "#8c9fa2"],
      backing: "#f8f6ea",
      speed: 1.1,
    },
    { density: 0.7, daubSize: 1.4, clearRadius: 8, wind: 1.8, cloudShadow: 0.8, ridgeHeight: 0.5 },
  ),
  preset(
    {
      id: "p4",
      name: "Canowindra",
      mode: "light",
      colors: ["#c8c98e", "#eaeccb", "#a4aab5", "#899dbc"],
      backing: "#f4f6ee",
      speed: 1,
    },
    {
      density: 1.1,
      daubSize: 1.05,
      clearRadius: 7,
      wind: 1.2,
      cloudShadow: 0.65,
      ridgeHeight: 1.2,
    },
  ),
  preset(
    {
      id: "p5",
      name: "Bathurst",
      mode: "light",
      colors: ["#d2c49f", "#eeece0", "#a8a7b4", "#9699b8"],
      backing: "#f5f6f3",
      speed: 0.8,
    },
    { density: 0.9, daubSize: 1.2, clearRadius: 9.5, wind: 0.5, cloudShadow: 1, ridgeHeight: 1.5 },
  ),
  preset(
    {
      id: "p6",
      name: "Hill End",
      mode: "dark",
      colors: ["#544421", "#685c3d", "#2a2a31", "#1c2638"],
      backing: "#121826",
      speed: 1,
    },
    { density: 1, daubSize: 1, clearRadius: 6.5, wind: 1, cloudShadow: 0.6, ridgeHeight: 1 },
  ),
  preset(
    {
      id: "p7",
      name: "Gulgong",
      mode: "dark",
      colors: ["#4b4d3c", "#5f6250", "#242a31", "#1a2536"],
      backing: "#0f141c",
      speed: 0.8,
    },
    { density: 1.3, daubSize: 0.8, clearRadius: 6, wind: 0.6, cloudShadow: 0.35, ridgeHeight: 0.7 },
  ),
  preset(
    {
      id: "p8",
      name: "Hay Plain",
      mode: "dark",
      colors: ["#5e3d27", "#6f5140", "#2d2326", "#2a2436"],
      backing: "#161218",
      speed: 1.1,
    },
    {
      density: 0.65,
      daubSize: 1.45,
      clearRadius: 8.5,
      wind: 2,
      cloudShadow: 0.8,
      ridgeHeight: 0.4,
    },
  ),
  preset(
    {
      id: "p9",
      name: "Sofala",
      mode: "dark",
      colors: ["#4a4726", "#5d5a3b", "#22282b", "#172333"],
      backing: "#0e1317",
      speed: 0.9,
    },
    {
      density: 1.1,
      daubSize: 1.15,
      clearRadius: 7.5,
      wind: 1.3,
      cloudShadow: 0.9,
      ridgeHeight: 1.45,
    },
  ),
];
