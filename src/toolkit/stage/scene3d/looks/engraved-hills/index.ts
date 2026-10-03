import { goboCompanionSun } from "../../kit/gobo";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
  Scene3dCompanionLighting,
} from "../../types";
import { EngravedHills } from "./EngravedHills";
import { HILLS_SUN } from "./hills";

export const look: Scene3dBackgroundDef = {
  id: "engraved-hills",
  name: "Engraved hills",
  family: "lines",
  colorSlots: [
    { label: "Ink", fallback: "#625c52" },
    { label: "Far ink", fallback: "#46463f" },
    { label: "Sky ink", fallback: "#434a53" },
  ],
  params: {
    rangeHeight: { label: "Range height", default: 1, min: 0.5, max: 1.5, step: 0.05 },
    pitch: { label: "Line pitch", default: 9, min: 5, max: 14, step: 0.5 },
    swell: { label: "Line swell", default: 1, min: 0.4, max: 1.4, step: 0.05 },
    crossHatch: { label: "Cross-hatch", default: 1, min: 0, max: 1, step: 0.05 },
    sunSwing: { label: "Sun swing", default: 50, min: 0, max: 90, step: 1 },
    clouds: { label: "Cloud drift", default: 1, min: 0, max: 3, step: 0.05 },
  },
  Component: EngravedHills,
};

/** Matching rig: a warm low key from the engraving sun's mean bearing (side-on from camera right), so device shading agrees with the plate. Companion blocks are static, so the swing is left out. */
function hillsLighting(mode: "light" | "dark", kelvin: number): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:dawn", intensity: dark ? 0.3 : 0.7, rotationDeg: 0 },
    sun: goboCompanionSun(HILLS_SUN, { intensity: dark ? 1.1 : 1.7, kelvin, angularDeg: 2 }),
    ambient: dark ? 0.18 : 0.45,
  };
}

type Tune = Omit<Scene3dBackgroundPreset, "mode" | "textColor" | "lighting">;

const preset = (mode: "light" | "dark", kelvin: number, p: Tune): Scene3dBackgroundPreset => ({
  ...p,
  mode,
  textColor: mode === "light" ? "#000000" : "#ffffff",
  lighting: hillsLighting(mode, kelvin),
});

/** Victorian high country and Gippsland names. p1 and p6 are the approved sketch palettes (p1's ink lifted to the Theme tile floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("light", 4200, {
    id: "p1",
    name: "Dandenong",
    colors: ["#949c8e", "#aab2a8", "#a5b0ba"],
    backing: "#f4f2ea",
    speed: 1,
    params: {
      rangeHeight: 1,
      pitch: 9,
      swell: 1,
      crossHatch: 1,
      sunSwing: 50,
      clouds: 1,
    },
  }),
  preset("light", 4800, {
    id: "p2",
    name: "Dinner Plain",
    colors: ["#8e98a6", "#a8b1bd", "#a3adba"],
    backing: "#f2f3f5",
    speed: 1,
    params: {
      rangeHeight: 1.15,
      pitch: 7,
      swell: 1.1,
      crossHatch: 1,
      sunSwing: 60,
      clouds: 0.8,
    },
  }),
  preset("light", 3800, {
    id: "p3",
    name: "Kiewa Valley",
    colors: ["#a39581", "#b8ad9c", "#b2a99b"],
    backing: "#f6f1e7",
    speed: 1,
    params: {
      rangeHeight: 0.85,
      pitch: 10,
      swell: 1.2,
      crossHatch: 0.6,
      sunSwing: 40,
      clouds: 1.2,
    },
  }),
  preset("light", 4400, {
    id: "p4",
    name: "Mirboo North",
    colors: ["#8f9b89", "#adb7a6", "#a9b4ab"],
    backing: "#f1f3ec",
    speed: 1,
    params: {
      rangeHeight: 0.7,
      pitch: 8,
      swell: 0.9,
      crossHatch: 0.3,
      sunSwing: 70,
      clouds: 1.5,
    },
  }),
  preset("light", 3600, {
    id: "p5",
    name: "Grand Ridge",
    colors: ["#a39390", "#bbaeab", "#b3a9ab"],
    backing: "#f6f1ef",
    speed: 1,
    params: {
      rangeHeight: 1.3,
      pitch: 11,
      swell: 1,
      crossHatch: 1,
      sunSwing: 30,
      clouds: 0.6,
    },
  }),
  preset("dark", 3800, {
    id: "p6",
    name: "Gariwerd",
    colors: ["#625c52", "#46463f", "#434a53"],
    backing: "#100f0d",
    speed: 1,
    params: {
      rangeHeight: 1,
      pitch: 9,
      swell: 1,
      crossHatch: 1,
      sunSwing: 50,
      clouds: 1,
    },
  }),
  preset("dark", 4600, {
    id: "p7",
    name: "Wonnangatta",
    colors: ["#575f6a", "#40464f", "#3f4552"],
    backing: "#0e1014",
    speed: 1,
    params: {
      rangeHeight: 1.2,
      pitch: 8,
      swell: 1.1,
      crossHatch: 0.8,
      sunSwing: 60,
      clouds: 0.8,
    },
  }),
  preset("dark", 4000, {
    id: "p8",
    name: "Howqua",
    colors: ["#5a6255", "#424a40", "#3f4842"],
    backing: "#0f120e",
    speed: 1,
    params: {
      rangeHeight: 0.8,
      pitch: 10,
      swell: 0.9,
      crossHatch: 0.5,
      sunSwing: 40,
      clouds: 1.3,
    },
  }),
  preset("dark", 3400, {
    id: "p9",
    name: "Cobungra",
    colors: ["#655a62", "#4a424a", "#46404c"],
    backing: "#110e11",
    speed: 1,
    params: {
      rangeHeight: 1.4,
      pitch: 12,
      swell: 1.2,
      crossHatch: 1,
      sunSwing: 75,
      clouds: 0.6,
    },
  }),
];
