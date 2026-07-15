import type { Light, Mesh, MeshStandardMaterial, Scene, Texture, WebGLRenderer } from "three";
import { compositorTargetFingerprint } from "./compositor";

/** A diagnostic snapshot of every render-state value that could silently diverge between builds or machines, attached to every verify result in `last-run.json` so "same project, different hash" starts with a one-line JSON diff instead of frame archaeology (also stands in for the GL truth log in packaged runs, where the dev console bridge doesn't exist). Captured at the LAST frame of a run: per-scene state reflects the final scene and every lit material has its final values; traversal order is scene-graph order (deterministic for a given project) and material rows are sorted by (name, uuid-free content) so diffs align across processes. */
export interface RenderStateFingerprint {
  toneMapping: number;
  toneMappingExposure: number;
  outputColorSpace: string;
  contextAntialias: boolean | null;
  drawingBufferSamples: number;
  maxSamples: number;
  environment: {
    kind: string;
    mapping: number;
    colorSpace: string;
    width: number | null;
    height: number | null;
  } | null;
  environmentIntensity: number;
  background: string | null;
  backgroundIntensity: number;
  /** Compositor A/B transition-target formats (part of the transition contract); null until the run's first transition frame allocates them. */
  compositorTargets: { sdr: string; hdr: string | null; samples: number } | null;
  lights: { type: string; intensity: number; color: string }[];
  /** Lit (standard/physical) materials only; the specular-relevant surface. */
  materials: {
    name: string;
    type: string;
    color: string;
    roughness: number;
    metalness: number;
    envMapIntensity: number;
    hasMap: boolean;
    hasNormalMap: boolean;
    hasOwnEnvMap: boolean;
    hasOnBeforeCompile: boolean;
  }[];
}

function textureInfo(tex: Texture | null): RenderStateFingerprint["environment"] {
  if (!tex) return null;
  const image = tex.image as { width?: number; height?: number } | undefined;
  return {
    kind: tex.constructor?.name ?? tex.type.toString(),
    mapping: tex.mapping,
    colorSpace: tex.colorSpace,
    width: image?.width ?? null,
    height: image?.height ?? null,
  };
}

export function renderStateFingerprint(gl: WebGLRenderer, scene: Scene): RenderStateFingerprint {
  const ctx = gl.getContext();
  const lights: RenderStateFingerprint["lights"] = [];
  const materials: RenderStateFingerprint["materials"] = [];
  const seen = new Set<string>();
  scene.traverse((obj) => {
    const light = obj as Light;
    if (light.isLight) {
      lights.push({
        type: light.type,
        intensity: light.intensity,
        color: light.color?.getHexString() ?? "",
      });
    }
    const mesh = obj as Mesh;
    if (mesh.isMesh) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const m = mat as MeshStandardMaterial;
        if (!m?.isMeshStandardMaterial || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        materials.push({
          name: m.name,
          type: m.type,
          color: m.color.getHexString(),
          roughness: m.roughness,
          metalness: m.metalness,
          envMapIntensity: m.envMapIntensity,
          hasMap: !!m.map,
          hasNormalMap: !!m.normalMap,
          hasOwnEnvMap: !!m.envMap,
          hasOnBeforeCompile: m.onBeforeCompile.toString().length > 40,
        });
      }
    }
  });
  materials.sort((a, b) =>
    `${a.name}/${a.color}/${a.roughness}`.localeCompare(`${b.name}/${b.color}/${b.roughness}`),
  );
  const bg = scene.background;
  return {
    toneMapping: gl.toneMapping,
    toneMappingExposure: gl.toneMappingExposure,
    outputColorSpace: gl.outputColorSpace,
    contextAntialias: ctx.getContextAttributes()?.antialias ?? null,
    drawingBufferSamples: ctx.getParameter(ctx.SAMPLES) as number,
    // MAX_SAMPLES is WebGL2-only; the app always runs WebGL2 in WKWebView, but type-guard anyway so a hypothetical GL1 fallback reads 0 instead of crashing the diagnostic.
    maxSamples: "MAX_SAMPLES" in ctx ? ((ctx.getParameter(ctx.MAX_SAMPLES) as number) ?? 0) : 0,
    environment: textureInfo(scene.environment),
    environmentIntensity: scene.environmentIntensity,
    background: bg
      ? "isColor" in bg && bg.isColor
        ? bg.getHexString()
        : (textureInfo(bg as Texture)?.kind ?? "texture")
      : null,
    backgroundIntensity: scene.backgroundIntensity,
    compositorTargets: compositorTargetFingerprint(),
    lights,
    materials,
  };
}
