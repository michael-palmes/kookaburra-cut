import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { GuillocheMedallion } from "./GuillocheMedallion";

/** Guilloche medallion (lines): banknote guilloche cut on a rose-engine lathe, as a floor dial and a counter-turning ceiling dial framing an open horizon. */
export const look: Scene3dBackgroundDef = {
  id: "guilloche-medallion",
  name: "Guilloche medallion",
  family: "lines",
  colorSlots: [
    { label: "Strand A", fallback: "#66593c" },
    { label: "Strand B", fallback: "#4a5b47" },
    { label: "Underprint", fallback: "#1a1812" },
  ],
  params: {
    outerRadius: { label: "Dial size", default: 37, min: 24, max: 50, step: 0.5 },
    ceilingHeight: { label: "Ceiling height", default: 5, min: 4, max: 14, step: 0.25 },
    strands: { label: "Strands per band", default: 8, min: 4, max: 12, step: 1 },
    lineWidth: { label: "Line width", default: 0.07, min: 0.03, max: 0.12, step: 0.005 },
    weave: { label: "Re-weave speed", default: 1, min: 0, max: 3, step: 0.05 },
    sheen: { label: "Lathe sheen", default: 1, min: 0, max: 1.5, step: 0.05 },
    underprint: { label: "Underprint", default: 0.6, min: 0, max: 1, step: 0.05 },
  },
  Component: GuillocheMedallion,
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

/** Victorian goldfields names. p1 and p6 are the approved sketch palettes (p1's strands lifted to the 0.315 floor). */
export const presets: Scene3dBackgroundPreset[] = [
  preset("p1", "Ballarat", "light", ["#a89878", "#90a08e", "#e7e1d0"], "#f6f2e9", 1, {
    outerRadius: 37,
    ceilingHeight: 5,
    strands: 8,
    lineWidth: 0.07,
    weave: 1,
    sheen: 1,
    underprint: 0.8,
  }),
  preset("p2", "Clunes", "light", ["#8b98ae", "#b39b97", "#d5d6dc"], "#f1f0f3", 0.9, {
    outerRadius: 40,
    ceilingHeight: 6,
    strands: 10,
    lineWidth: 0.07,
    weave: 0.8,
    sheen: 0.8,
    underprint: 0.75,
  }),
  preset("p3", "Maldon", "light", ["#879d8c", "#aaa27c", "#d3dacb"], "#f0f2eb", 1, {
    outerRadius: 32,
    ceilingHeight: 5,
    strands: 6,
    lineWidth: 0.1,
    weave: 1.4,
    sheen: 1.2,
    underprint: 0.85,
  }),
  preset("p4", "Beechworth", "light", ["#ad9578", "#97a0a8", "#e0d3c3"], "#f6f0e8", 1.1, {
    outerRadius: 46,
    ceilingHeight: 7,
    strands: 8,
    lineWidth: 0.08,
    weave: 0.6,
    sheen: 1.3,
    underprint: 0.7,
  }),
  preset("p5", "Castlemaine", "light", ["#a294b0", "#8ea4a6", "#d9d0de"], "#f3eff4", 0.9, {
    outerRadius: 28,
    ceilingHeight: 4.5,
    strands: 12,
    lineWidth: 0.06,
    weave: 2,
    sheen: 0.6,
    underprint: 0.85,
  }),
  preset("p6", "Bendigo", "dark", ["#66593c", "#4a5b47", "#1a1812"], "#110f0b", 1, {
    outerRadius: 37,
    ceilingHeight: 5,
    strands: 8,
    lineWidth: 0.07,
    weave: 1,
    sheen: 1,
    underprint: 0.6,
  }),
  preset("p7", "Steiglitz", "dark", ["#3f605c", "#5d5a43", "#121a19"], "#0b1211", 1, {
    outerRadius: 34,
    ceilingHeight: 5.5,
    strands: 10,
    lineWidth: 0.06,
    weave: 1.2,
    sheen: 1.2,
    underprint: 0.5,
  }),
  preset("p8", "Moliagul", "dark", ["#6a5c3d", "#475674", "#141824"], "#0d1018", 0.9, {
    outerRadius: 44,
    ceilingHeight: 6.5,
    strands: 6,
    lineWidth: 0.09,
    weave: 0.7,
    sheen: 1.4,
    underprint: 0.7,
  }),
  preset("p9", "Tarnagulla", "dark", ["#6b4c53", "#4b5a64", "#1a1417"], "#110d0f", 1.1, {
    outerRadius: 30,
    ceilingHeight: 4.5,
    strands: 12,
    lineWidth: 0.05,
    weave: 1.8,
    sheen: 0.8,
    underprint: 0.8,
  }),
];
