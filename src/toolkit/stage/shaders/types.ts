import type { IUniform } from "three";

/** One tunable number on a shader background (the inspector renders a slider per entry). */
export interface ShaderBackgroundParamDef {
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

/** A vendored paper-design effect adapted to the one-canvas engine: the GLSL3 fragment renders on the camera-locked background quad with `u_time` driven from the deterministic clock (never an internal rAF). */
export interface ShaderBackgroundDef {
  id: string;
  name: string;
  /** GLSL3 fragment body: no `#version`/`precision` lines (three's ShaderMaterial prepends them) but it MUST declare and write its own `out vec4 fragColor;` — this three version does not alias `gl_FragColor` for GLSL3 custom shaders (the transitionShader convention). */
  fragment: string;
  /** Ordered colour slots with hex fallbacks — the shader's first DARK preset, so a fresh pick reads with white text on the default dark theme (docs/backgrounds.md); a vitest pins the match. */
  colorSlots: { label: string; fallback: string }[];
  /** For `u_colors[]`-array shaders: how many colours the array accepts; absent = fixed named slots only. */
  maxColors?: number;
  /** True when the fragment samples `u_noiseTexture`; the engine attaches the shared randomizer DataTexture (noiseTexture.ts). */
  noise?: boolean;
  params: Record<string, ShaderBackgroundParamDef>;
  /** Static uniforms for a resolved spec — `u_time` excluded (the engine writes it every frame) and the vertex sizing uniforms excluded (the quad owns them). Colours arrive as linear 0-1 RGBA tuples. */
  uniforms(
    colors: [number, number, number, number][],
    params: Record<string, number>,
  ): Record<string, IUniform>;
}
