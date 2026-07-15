import { Environment, Lightformer, useGLTF } from "@react-three/drei";
import { useMemo } from "react";
import { Box3, type Object3D, Vector3 } from "three";
import { useTimeline } from "../../engine/timeline";
import { HIDDEN_NODES } from "../device/models";
import { LightRig } from "../lighting/LightRig";
import { useSceneStaged } from "../stage/context";
import type { V3 } from "../types";
import { HERO_MODELS, type HeroModelName } from "./models";

export interface HeroObjectProps {
  /** Which bundled hero model to render. */
  model: HeroModelName;
  position?: V3;
  /** Base rotation in radians (idle spin adds to `rotation[1]`). */
  rotation?: V3;
  /** Multiplier on the auto-fit scale (models auto-size to a sensible world height). */
  scale?: number;
  /** Idle spin about Y, in degrees/second, a pure function of the timeline. */
  spinDegPerSec?: number;
  /** Gentle vertical bob, in world units (0 disables). Pure function of the timeline. */
  floatAmplitude?: number;
  /** Bob frequency, in cycles/second. */
  floatHz?: number;
  /** Bundle the lit set (rig + one-shot environment); defaults true, or false under a lighting `<SceneStage>` since the stage lights the scene; an explicit value wins. */
  lit?: boolean;
}

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
/** World-space height heroes are auto-fit to; same framing constant as DeviceMockup. */
const TARGET_WORLD_HEIGHT = 2.6;

/** Product/hero glTF object on a lit set, the generic sibling of `DeviceMockup`: loads a bundled model by name, recentres + auto-fits it, and offers idle spin + float driven by `useTimeline()`; the export preamble awaits `preloadHeroModels()` so a cold export never captures a still-loading hero. See docs/determinism.md. */
export function HeroObject(props: HeroObjectProps) {
  const {
    model,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    scale = 1,
    spinDegPerSec = 0,
    floatAmplitude = 0,
    floatHz = 0.5,
    lit,
  } = props;

  // Staged scenes light themselves; the bundled lit set stands down by default.
  const staged = useSceneStaged();
  const isLit = lit ?? !staged;

  const { localMs } = useTimeline();
  const { scene } = useGLTF(HERO_MODELS[model]);

  // Clone once per model (drei's cache is shared, never mutate it), drop baked backdrop plates, then recentre on the origin and auto-fit to a fixed world height.
  const { root, fit } = useMemo(() => {
    const clone = scene.clone(true);
    const hide: Object3D[] = [];
    clone.traverse((obj: Object3D) => {
      if (HIDDEN_NODES.has(obj.name)) hide.push(obj);
    });
    for (const obj of hide) obj.removeFromParent();

    clone.updateMatrixWorld(true);
    const box = new Box3().setFromObject(clone);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    clone.position.sub(center);
    const fit = size.y > 1e-6 ? TARGET_WORLD_HEIGHT / size.y : 1;
    return { root: clone, fit };
  }, [scene]);

  const t = localMs / 1000;
  const spinY = spinDegPerSec * t * DEG2RAD;
  const floatY = floatAmplitude * Math.sin(TWO_PI * floatHz * t);

  return (
    <group
      position={[position[0], position[1] + floatY, position[2]]}
      rotation={[rotation[0], rotation[1] + spinY, rotation[2]]}
    >
      {isLit && (
        <>
          <LightRig />
          {/* Procedural, offline environment (rendered once) so metals read as metal; same set as DeviceMockup. */}
          <Environment resolution={256} frames={1}>
            <Lightformer form="rect" intensity={2} position={[0, 3, 4]} scale={8} />
            <Lightformer form="rect" intensity={1.2} position={[-4, 1, 2]} scale={5} />
            <Lightformer form="rect" intensity={1} position={[4, -1, 3]} scale={5} />
          </Environment>
        </>
      )}
      <group scale={scale * fit}>
        <primitive object={root} />
      </group>
    </group>
  );
}
