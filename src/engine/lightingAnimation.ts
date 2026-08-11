import {
  Color,
  type DirectionalLight,
  type Group,
  type InstancedMesh,
  type Light,
  MathUtils,
  type Mesh,
  type MeshBasicMaterial,
  type Scene,
} from "three";
import type { FixtureSpec, LightSpec, SunSpec } from "../theme/tokens";
import type { FixtureInstance } from "./fixtures";
import { kelvinToHex } from "./kelvin";
import { placementPosition, sunPosition } from "./orbit";
import type { SceneLightingSample } from "./sceneLighting";

/** The keyframe APPLY seam (v9 · PR 6): a registry of mounted, animatable lighting objects (populated by SceneStage, StageLights and Fixture on mount) plus `applyFrameLighting`, called per render target at the compositor seam after the camera, relative lights and scene state. Every value written is pose-field ?? base, EXPLICITLY, for every handle of the target's scene on every planned frame, so a transition's A and B never leak values into each other and nothing accumulates (the stale-state lesson). A project with no lighting track never builds a plan and this module never runs. */

interface SunHandle {
  kind: "sun";
  sceneIndex: number;
  light: DirectionalLight;
  base: SunSpec;
  baseColor: string;
}

interface AmbientHandle {
  kind: "ambient";
  sceneIndex: number;
  light: Light;
  base: number;
}

interface LightHandle {
  kind: "light";
  sceneIndex: number;
  id: string;
  light: Light;
  base: LightSpec;
  baseColor: string;
}

interface FixtureHandle {
  kind: "fixture";
  sceneIndex: number;
  id: string;
  base: FixtureSpec;
  baseColor: string;
  instances: FixtureInstance[];
  /** Non-instanced glow meshes in instance order (empty when instanced). */
  meshes: Mesh[];
  instanced: InstancedMesh | null;
  /** Paired lights in thinned-instance order. */
  pairedLights: Light[];
  /** Root of the complete fixture rig, including repeated/mirrored instances. */
  group: Group;
}

type Handle = SunHandle | AmbientHandle | LightHandle | FixtureHandle;

const handles = new Map<string, Handle>();

export function registerLightingAnimatable(key: string, handle: Handle): () => void {
  handles.set(key, handle);
  return () => {
    handles.delete(key);
  };
}

/** Exposed for tests. */
export function lightingAnimatableCount(): number {
  return handles.size;
}

const _color = new Color();

/** Write the sampled pose (fields ?? base) onto every mounted handle of the sample's scene, plus the scene-level environment overrides. No sample: nothing runs (the legacy path). */
export function applyFrameLighting(
  scene: Scene,
  sample: SceneLightingSample | null | undefined,
): void {
  if (!sample) return;
  const pose = sample.pose;
  if (pose.environmentIntensity !== undefined) {
    scene.environmentIntensity = pose.environmentIntensity;
  }
  if (pose.environmentRotationDeg !== undefined) {
    scene.environmentRotation.set(0, MathUtils.degToRad(pose.environmentRotationDeg), 0);
  }
  for (const handle of handles.values()) {
    if (handle.sceneIndex !== sample.index) continue;
    switch (handle.kind) {
      case "sun": {
        const sun = pose.sun;
        const az = sun?.azimuthDeg ?? handle.base.azimuthDeg;
        const el = sun?.elevationDeg ?? handle.base.elevationDeg;
        handle.light.position.set(...sunPosition(az, el));
        handle.light.intensity = sun?.intensity ?? handle.base.intensity;
        const kelvin = sun?.kelvin ?? handle.base.kelvin;
        handle.light.color.set(kelvin !== undefined ? kelvinToHex(kelvin) : handle.baseColor);
        break;
      }
      case "ambient":
        handle.light.intensity = pose.ambient ?? handle.base;
        break;
      case "light": {
        const entry = pose.lights?.[handle.id];
        handle.light.intensity = entry?.intensity ?? handle.base.intensity;
        const kelvin = entry?.kelvin ?? handle.base.kelvin;
        handle.light.color.set(kelvin !== undefined ? kelvinToHex(kelvin) : handle.baseColor);
        // Keyed placement drives WORLD lights only; camera/subject transforms belong to applyRelativeLights.
        if ((handle.base.space ?? "world") === "world") {
          const placement = entry?.placement ?? handle.base.placement;
          handle.light.position.set(
            ...placementPosition(placement, handle.base.target ?? [0, 0, 0]),
          );
        }
        break;
      }
      case "fixture": {
        const entry = pose.fixtures?.[handle.id];
        const emissive = entry?.emissive ?? handle.base.emissive;
        const lightIntensity = entry?.lightIntensity ?? handle.base.lightIntensity;
        if ((handle.base.space ?? "world") === "world") {
          const placement = entry?.placement ?? handle.base.placement;
          handle.group.position.set(...placementPosition(placement));
        }
        if (handle.instanced) {
          handle.instances.forEach((inst, i) => {
            _color.set(handle.baseColor).multiplyScalar(emissive * inst.emissiveScale);
            handle.instanced?.setColorAt(i, _color);
          });
          if (handle.instanced.instanceColor) handle.instanced.instanceColor.needsUpdate = true;
        } else {
          handle.meshes.forEach((mesh, i) => {
            const scale = handle.instances[i]?.emissiveScale ?? 1;
            (mesh.material as MeshBasicMaterial).color
              .set(handle.baseColor)
              .multiplyScalar(emissive * scale);
          });
        }
        for (const light of handle.pairedLights) light.intensity = lightIntensity;
        break;
      }
    }
  }
}
