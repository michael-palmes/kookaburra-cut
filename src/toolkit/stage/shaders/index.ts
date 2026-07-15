import { meshGradient } from "./meshGradient";
import { neuroNoise } from "./neuroNoise";
import { simplexNoise } from "./simplexNoise";
import { smokeRing } from "./smokeRing";
import { swirl } from "./swirl";
import type { ShaderBackgroundDef } from "./types";
import { warp } from "./warp";

export const SHADER_BACKGROUNDS: Record<string, ShaderBackgroundDef> = {
  "mesh-gradient": meshGradient,
  "simplex-noise": simplexNoise,
  swirl,
  "neuro-noise": neuroNoise,
  warp,
  "smoke-ring": smokeRing,
};

export const SHADER_BACKGROUND_IDS: string[] = [
  "mesh-gradient",
  "simplex-noise",
  "swirl",
  "neuro-noise",
  "warp",
  "smoke-ring",
];

export { SHADER_BACKGROUND_PRESETS, type ShaderBackgroundPreset } from "./presets";
export type { ShaderBackgroundDef, ShaderBackgroundParamDef } from "./types";
export { shaderBackgroundVertex } from "./vertex";
