import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import type { Material, Mesh, Scene, WebGLRenderer } from "three";
import { useEffectsStore } from "./effectsStore";
import { type RenderSettings, threeToneMapping } from "./renderSettings";

/** Write the project's display transform onto the renderer (the non-effects render path; the composer path reads the store itself). Changing `gl.toneMapping` does NOT recompile already-built material programs, so a real mode change must also flag every tone-mapped material; the ACES-at-1.0 default writes the values three already holds, leaving every existing project's programs untouched. */
export function applyRenderSettings(
  gl: WebGLRenderer,
  scene: Scene,
  settings: RenderSettings,
): boolean {
  const mode = threeToneMapping(settings.toneMapping);
  const modeChanged = gl.toneMapping !== mode;
  const changed = modeChanged || gl.toneMappingExposure !== settings.exposure;
  gl.toneMapping = mode;
  gl.toneMappingExposure = settings.exposure;
  if (modeChanged) {
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials as Material[]) {
        if (material) material.needsUpdate = true;
      }
    });
  }
  return changed;
}

/** Mounted inside the Canvas: applies on project load (the store publish) and repaints. */
export function RenderSettingsApplier() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const apply = () => {
      if (applyRenderSettings(gl, scene, useEffectsStore.getState().renderSettings)) {
        invalidate();
      }
    };
    apply();
    return useEffectsStore.subscribe(apply);
  }, [gl, scene, invalidate]);
  return null;
}
