import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { PendulumRing } from "./PendulumRing";
import { PENDULUM } from "./pendulum";

export const look: Scene3dBackgroundDef = {
  id: "pendulum-ring",
  name: "Pendulum ring",
  family: "kinetic",
  colorSlots: [
    { label: "Bob", fallback: "#5f4f37" },
    { label: "Sheen", fallback: "#6c5a3b" },
    { label: "Thread", fallback: "#44423d" },
    { label: "Rail", fallback: "#383d42" },
  ],
  params: {
    count: { label: "Bobs per inner rail", default: 48, min: 24, max: PENDULUM.maxCount, step: 1 },
    rows: { label: "Rails", default: 3, min: 1, max: PENDULUM.maxRails, step: 1 },
    swing: { label: "Swing (u)", default: 0.5, min: 0.1, max: 0.7, step: 0.01 },
    period: { label: "Realign (s)", default: 480, min: 240, max: 960, step: 10 },
    radius: { label: "Radius", default: 11, min: 9.5, max: 16, step: 0.1 },
    epoch: { label: "Start pattern (s)", default: 40, min: 0, max: 240, step: 1 },
  },
  previewCamera: "ceiling",
  Component: PendulumRing,
};

const light = { mode: "light", textColor: "#000000" } as const;
const dark = { mode: "dark", textColor: "#ffffff" } as const;

export const presets: Scene3dBackgroundPreset[] = [
  {
    id: "p1",
    name: "Ellenborough",
    ...light,
    colors: ["#ae9676", "#dccbaa", "#a09a90", "#a9b0b5"],
    backing: "#f5f3ee",
    speed: 1,
    params: { count: 48, rows: 3, swing: 0.5, period: 480, radius: 11, epoch: 40 },
  },
  {
    id: "p2",
    name: "Minnamurra",
    ...light,
    colors: ["#b8927e", "#e3c7b2", "#a3998f", "#b0aaa4"],
    backing: "#f8f2ee",
    speed: 1,
    params: { count: 60, rows: 2, swing: 0.4, period: 360, radius: 11.5, epoch: 90 },
  },
  {
    id: "p3",
    name: "Purling Brook",
    ...light,
    colors: ["#959f94", "#cfd6c8", "#9a9d95", "#a7b0aa"],
    backing: "#f2f5f1",
    speed: 0.9,
    params: {
      count: 36,
      rows: 4,
      swing: 0.55,
      period: 600,
      radius: 10.5,
      epoch: 150,
    },
  },
  {
    id: "p4",
    name: "Elabana",
    ...light,
    colors: ["#97a0b0", "#d2d7e0", "#97999f", "#aab0bb"],
    backing: "#f3f4f7",
    speed: 1.1,
    params: { count: 72, rows: 1, swing: 0.35, period: 300, radius: 12, epoch: 20 },
  },
  {
    id: "p5",
    name: "Carrington Falls",
    ...light,
    colors: ["#b59a64", "#e4d0a0", "#a69c86", "#b3ab98"],
    backing: "#f9f5ea",
    speed: 1,
    params: {
      count: 42,
      rows: 3,
      swing: 0.6,
      period: 720,
      radius: 12.5,
      epoch: 200,
    },
  },
  {
    id: "p6",
    name: "Jim Jim",
    ...dark,
    colors: ["#5f4f37", "#6c5a3b", "#44423d", "#383d42"],
    backing: "#0e0f11",
    speed: 1,
    params: { count: 48, rows: 3, swing: 0.5, period: 480, radius: 11, epoch: 40 },
  },
  {
    id: "p7",
    name: "Wollomombi",
    ...dark,
    colors: ["#63473a", "#74553f", "#46403d", "#3d3a3c"],
    backing: "#110d0c",
    speed: 0.9,
    params: { count: 56, rows: 2, swing: 0.45, period: 540, radius: 12, epoch: 120 },
  },
  {
    id: "p8",
    name: "Mitchell Falls",
    ...dark,
    colors: ["#48554a", "#536155", "#3e4540", "#353d3a"],
    backing: "#0d100e",
    speed: 1.1,
    params: { count: 32, rows: 4, swing: 0.6, period: 300, radius: 10, epoch: 60 },
  },
  {
    id: "p9",
    name: "Steavenson",
    ...dark,
    colors: ["#485262", "#54606f", "#40444c", "#363b46"],
    backing: "#0e1014",
    speed: 1,
    params: { count: 64, rows: 3, swing: 0.4, period: 840, radius: 13, epoch: 180 },
  },
];
