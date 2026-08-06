/** The lit finish of a 3D chart: ONE factory that every family (instanced bars, pie slices, line and area solids) builds its material through, so a preset's roughness, gloss, glass and edge glow land identically wherever they appear. A `MeshPhysicalMaterial` is built only when the preset actually asks for clearcoat or transmission, so the default preset keeps exactly today's `MeshStandardMaterial` program. The edge glow is an in-material rim term (never post-processing bloom, which is out of scope and would not be per mark), and every caller's own shader patch composes with it through `patch`. */

import { MeshPhysicalMaterial, MeshStandardMaterial } from "three";
import type { ChartStyleSurface3D } from "./types";

/** The shader object three hands `onBeforeCompile`. */
export type ChartShader = Parameters<MeshStandardMaterial["onBeforeCompile"]>[0];

/** Rim falloff and peak gain for `emissiveEdge`: tight enough to read as an edge light on the mark's own colour rather than a wash over its face. */
const EDGE_POWER = 2.6;
const EDGE_GAIN = 1.15;

/** The rim term, injected after three's own emissive so it rides `totalEmissiveRadiance` and stays the same lift under any stage light. */
function applyEdgeGlow(shader: ChartShader, gain: number): void {
  shader.uniforms.uChartEdge = { value: gain * EDGE_GAIN };
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nuniform float uChartEdge;")
    .replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
float chartRim = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
totalEmissiveRadiance += diffuseColor.rgb * uChartEdge * pow(chartRim, ${EDGE_POWER.toFixed(2)});`,
    );
}

export interface ChartMaterialOptions {
  colour?: string;
  /** Per-instance colour through `instanceColor` (the bar family). */
  vertexColors?: boolean;
  /** Names this call site's shader patch in the program cache; the factory adds what it compiles in itself. */
  cacheKey: string;
  /** The caller's own patch (instance channels, draw clips, bevel masks), composed under the finish's. */
  patch?: (shader: ChartShader) => void;
}

/** True when the preset's finish needs the physical model: clearcoat or transmission. */
export const isPhysicalFinish = (finish: ChartStyleSurface3D): boolean =>
  finish.clearcoat > 0 || finish.transmission > 0;

/** One mark material for a resolved finish. Glass is always a dielectric: `transmission` brings `thickness` and `ior` with it, and three renders it through its own transmissive pass, so nothing here toggles transparency (each family owns that, from its build alpha). */
export function makeChartMaterial(
  finish: ChartStyleSurface3D,
  options: ChartMaterialOptions,
): MeshStandardMaterial {
  const base = {
    color: options.colour,
    vertexColors: options.vertexColors ?? false,
    roughness: finish.roughness,
    metalness: finish.metalness,
  };
  const physical = isPhysicalFinish(finish);
  const material = physical
    ? new MeshPhysicalMaterial({
        ...base,
        clearcoat: finish.clearcoat,
        clearcoatRoughness: finish.clearcoatRoughness,
        transmission: finish.transmission,
        thickness: finish.thickness,
        ior: finish.ior,
      })
    : new MeshStandardMaterial(base);
  const edge = finish.emissiveEdge > 0;
  material.onBeforeCompile = (shader) => {
    options.patch?.(shader);
    if (edge) applyEdgeGlow(shader, finish.emissiveEdge);
  };
  const key = `${options.cacheKey}${physical ? "-physical" : ""}${edge ? "-edge" : ""}`;
  material.customProgramCacheKey = () => key;
  return material;
}
