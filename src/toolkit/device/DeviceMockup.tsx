import { Environment, Lightformer, useGLTF, useTexture } from "@react-three/drei";
import { useContext, useLayoutEffect, useMemo } from "react";
import {
  Box3,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type Object3D,
  SRGBColorSpace,
  Vector3,
} from "three";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext } from "../../engine/sceneContext";
import { useTimeline } from "../../engine/timeline";
import { useEditorStore } from "../../store/editorStore";
import type { V3 } from "../types";
import { DEVICE_MODELS, type DeviceModelName, HIDDEN_NODES, SCREEN_MATERIAL } from "./models";

export interface DeviceMockupProps {
  /** Which bundled handset model to render. */
  model: DeviceModelName;
  /** Project-relative image path shown on the device screen, e.g. `"assets/screen.png"`. */
  screen: string;
  /** Base rotation in radians. */
  rotation?: V3;
  position?: V3;
  /** Multiplier on the auto-fit scale (the model auto-sizes to a sensible world height). */
  scale?: number;
  /** Optional idle spin about Y, in degrees/second, a pure function of the timeline. */
  spinDegPerSec?: number;
}

const DEG2RAD = Math.PI / 180;
/** World-space height the handset is auto-fit to (~60% of the ~4.14u visible height). */
const TARGET_WORLD_HEIGHT = 2.6;

/** Name of the first material on a mesh (models may hold an array of materials). */
function materialName(material: Material | Material[]): string | undefined {
  return Array.isArray(material) ? material[0]?.name : material.name;
}

/** Loads a bundled handset glTF and maps a static project image onto its screen mesh; the export preamble awaits `preloadDeviceModels()` / `preloadProjectImages()` so a cold export never races a still-loading asset. See docs/determinism.md. */
export function DeviceMockup(props: DeviceMockupProps) {
  const {
    model,
    screen,
    rotation = [0, 0, 0],
    position = [0, 0, 0],
    scale = 1,
    spinDegPerSec = 0,
  } = props;

  const { localMs } = useTimeline();
  // The owning project's id (see ProjectIdContext): the store's projectId flips to the target project one render before this scene unmounts on a project switch, and resolveAssetUrl against the wrong project throws mid-render (glob miss), tearing down the canvas tree.
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;

  const { scene } = useGLTF(DEVICE_MODELS[model]);
  const screenTex = useTexture(resolveAssetUrl(projectId, screen));

  // Clone once per (model, texture) since drei's useGLTF cache is shared: hide the studio backdrop, swap the display mesh to an unlit material showing the screen, then recentre + auto-fit to a fixed world height.
  const { root, fit } = useMemo(() => {
    const clone = scene.clone(true);

    const hide: Object3D[] = [];
    clone.traverse((obj: Object3D) => {
      if (HIDDEN_NODES.has(obj.name)) {
        hide.push(obj);
        return;
      }
      const mesh = obj as Mesh;
      if (mesh.isMesh && materialName(mesh.material) === SCREEN_MATERIAL) {
        mesh.material = new MeshBasicMaterial({ map: screenTex, toneMapped: false });
      }
    });
    // Detach backdrop meshes AFTER traversal (so it's excluded from the bounding box below).
    for (const obj of hide) obj.removeFromParent();

    clone.updateMatrixWorld(true);
    const box = new Box3().setFromObject(clone);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    clone.position.sub(center); // centre the model on the origin
    const fit = size.y > 1e-6 ? TARGET_WORLD_HEIGHT / size.y : 1;
    return { root: clone, fit };
  }, [scene, screenTex]);

  // Match the loader's colour space and the glTF flipY convention so the screen image is neither washed out nor upside down on the model's UVs.
  useLayoutEffect(() => {
    screenTex.colorSpace = SRGBColorSpace;
    screenTex.flipY = false;
    screenTex.needsUpdate = true;
  }, [screenTex]);

  // Idle spin: pure function of the timeline value, never the wall clock (determinism).
  const spinY = ((spinDegPerSec * localMs) / 1000) * DEG2RAD;

  return (
    <group position={position} rotation={[rotation[0], rotation[1] + spinY, rotation[2]]}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[4, 6, 5]} intensity={2.4} />
      <directionalLight position={[-5, 2, -3]} intensity={0.9} />
      {/* Procedural, offline environment (rendered once) so the titanium reads as metal. */}
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={2} position={[0, 3, 4]} scale={8} />
        <Lightformer form="rect" intensity={1.2} position={[-4, 1, 2]} scale={5} />
        <Lightformer form="rect" intensity={1} position={[4, -1, 3]} scale={5} />
      </Environment>
      <group scale={scale * fit}>
        <primitive object={root} />
      </group>
    </group>
  );
}

// Preload bundled models so the first render has geometry ready (and, once export preload is wired, the export preamble can await the same cache).
for (const url of Object.values(DEVICE_MODELS)) {
  useGLTF.preload(url);
}
