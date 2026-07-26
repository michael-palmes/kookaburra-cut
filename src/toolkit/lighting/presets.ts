import type { LightingSpec } from "../../theme/tokens";

/** The lighting preset grid (v9 · PR 7): six complete looks spanning the product-video range, applied by VALUE into the scene doc (the shader-background preset model: the picker writes concrete numbers the user then tweaks; `preset` is stored only so the tile can highlight and Reset can offer itself, the renderer never reads it). Plain data, no computed values, so a designer can tune numbers without touching logic. `dark-rim` deliberately uses the theme's accent token (a theme swap restyles the rims); the physical looks stay Kelvin. */

export interface LightingPreset {
  id: string;
  label: string;
  description: string;
  spec: LightingSpec;
}

export const LIGHTING_PRESETS: readonly LightingPreset[] = [
  {
    id: "soft-studio",
    label: "Soft studio",
    description: "Clean, even, e-commerce hero. The safe default.",
    spec: {
      environment: { source: "kookaburra:ferndale-studio", intensity: 1, rotationDeg: 0 },
      sun: { azimuthDeg: 35, elevationDeg: 40, intensity: 1.8, kelvin: 5600, angularDeg: 6 },
      ambient: 0.4,
      lights: [
        {
          id: "fill",
          type: "area",
          intensity: 3,
          kelvin: 5600,
          width: 2.5,
          height: 2.5,
          placement: { mode: "orbit", azimuthDeg: -145, elevationDeg: 20, distance: 6 },
        },
      ],
    },
  },
  {
    id: "hard-keynote",
    label: "Hard keynote",
    description: "Single hard key, deep falloff, stage feel.",
    spec: {
      environment: { source: "kookaburra:monochrome-studio", intensity: 0.4, rotationDeg: 0 },
      sun: { azimuthDeg: 50, elevationDeg: 55, intensity: 3.2, kelvin: 5200, angularDeg: 1 },
      ambient: 0.15,
      lights: [
        {
          id: "rim",
          type: "spot",
          intensity: 60,
          kelvin: 5000,
          angleDeg: 40,
          penumbra: 0.5,
          placement: { mode: "orbit", azimuthDeg: 180, elevationDeg: 35, distance: 7 },
        },
      ],
      shadow: { technique: "map", softness: 0.3, opacity: 0.45, mapSize: 2048, bias: -0.0005 },
    },
  },
  {
    id: "neon-corridor",
    label: "Neon corridor",
    description: "The fluorescent fly-through. Tubes do the work.",
    spec: {
      environment: { source: "kookaburra:warehouse", intensity: 0.35, rotationDeg: 0 },
      sun: { azimuthDeg: 0, elevationDeg: 45, intensity: 1, enabled: false },
      ambient: 0.05,
      fixtures: [
        {
          id: "tubes",
          form: "tube",
          size: [3.2, 0.06],
          kelvin: 4200,
          emissive: 3.5,
          lightIntensity: 14,
          placement: { mode: "point", position: [0, 2.4, 0] },
          rotationDeg: [-90, 0, 0],
          repeat: { count: 8, spacing: 2.4, axis: "z" },
        },
      ],
    },
  },
  {
    id: "golden-hour",
    label: "Golden hour",
    description: "Warm low sun, long shadows, launch-film warmth.",
    spec: {
      environment: { source: "kookaburra:sunset", intensity: 0.9, rotationDeg: 0 },
      sun: { azimuthDeg: -60, elevationDeg: 12, intensity: 2.6, kelvin: 2900, angularDeg: 0.6 },
      ambient: 0.3,
      shadow: {
        technique: "map",
        softness: 0.35,
        opacity: 0.4,
        mapSize: 2048,
        bias: -0.0005,
        color: "#3a2a18",
      },
    },
  },
  {
    id: "dark-rim",
    label: "Dark rim",
    description: "Near-black; the product is defined entirely by edge light.",
    spec: {
      environment: { source: "kookaburra:night-city", intensity: 0.25, rotationDeg: 0 },
      sun: { azimuthDeg: 0, elevationDeg: 45, intensity: 1, enabled: false },
      ambient: 0.02,
      lights: [
        {
          id: "rim-left",
          type: "area",
          intensity: 8,
          colorToken: "accent",
          width: 1.2,
          height: 2.6,
          space: "camera",
          placement: { mode: "point", position: [-2.4, 0.4, -2.5] },
          target: [0, 0, -4],
        },
        {
          id: "rim-right",
          type: "area",
          intensity: 8,
          colorToken: "accent",
          width: 1.2,
          height: 2.6,
          space: "camera",
          placement: { mode: "point", position: [2.4, 0.4, -2.5] },
          target: [0, 0, -4],
        },
      ],
    },
  },
  {
    id: "clinical-white",
    label: "Clinical white",
    description: "Flat, shadowless, spec-sheet clarity.",
    spec: {
      environment: { source: "kookaburra:softbox", intensity: 1.4, rotationDeg: 0 },
      sun: { azimuthDeg: 0, elevationDeg: 70, intensity: 1.2, kelvin: 6500, angularDeg: 12 },
      ambient: 0.9,
      shadow: { technique: "none", softness: 0.5, opacity: 0, mapSize: 2048, bias: -0.0005 },
    },
  },
];
