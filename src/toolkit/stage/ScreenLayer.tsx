import { createPortal, useThree } from "@react-three/fiber";
import { type ReactNode, useContext, useId, useLayoutEffect, useMemo, useState } from "react";
import {
  BufferGeometry,
  Group,
  type Material,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  type WebGLRenderer,
} from "three";
import { baseCameraPose } from "../../engine/cameraTrack";
import { registerFramePanel, unregisterFramePanel } from "../../engine/framePanelRegistry";
import { FormatContext, SceneContext } from "../../engine/sceneContext";

export interface ScreenLayerProps {
  /** "front" (default) draws over the finished frame, past depth of field; "back" draws over the background and under everything 3D, and its pixels go through the scene's effects and transitions like the backdrop. */
  order?: "front" | "back";
  children?: ReactNode;
}

/** After the room (-40), before all content (0): every 3D thing paints over a back layer. */
export const SCREEN_BACK_RENDER_ORDER = -30;

/** A camera-locked layer laid out in frame units: (0, 0) is the centre and `useFormat().frame` the full size, whatever the scene camera does, and nothing in the 3D pass can hide it (no depth test). Replaces a hand-built pose in front of `useSceneCamera()`. For flat primitives (text, images, shapes, `Vignette`, `Scrim`, `Gradient`): a 3D model needs its depth test, and its materials are shared with any world copy. Both orders draw inside the compositor's own passes, so preview, Present and export agree. */
export function ScreenLayer({ order = "front", children }: ScreenLayerProps) {
  return order === "back" ? <BackLayer>{children}</BackLayer> : <FrontLayer>{children}</FrontLayer>;
}

let warnedNoScene = false;

/** The compositor's panel pass draws this over the finished frame from the base camera pose, depth cleared. A comparison draws it once over the composite, so side B never mounts its own; a framed scene's layer covers the whole frame, so it lays out against the full format, not the cutout. */
function FrontLayer({ children }: { children?: ReactNode }) {
  const scene = useThree((s) => s.scene);
  const context = useContext(SceneContext);
  const key = useId();
  const [group] = useState(() => {
    const g = new Group();
    g.visible = false;
    return g;
  });
  const index = context?.index;
  const drawn = index !== undefined && context?.side !== "b";
  if (index === undefined && !warnedNoScene) {
    warnedNoScene = true;
    console.warn(
      '[stage] ScreenLayer order="front" needs a scene; a persistent module draws nothing',
    );
  }
  useLayoutEffect(() => {
    if (!drawn || index === undefined) return;
    scene.add(group);
    registerFramePanel(key, {
      index,
      group,
      hasSceneImages: true,
      screenLayer: true,
      beforeDraw: () => stackInJsxOrder(group),
    });
    return () => {
      unregisterFramePanel(key);
      scene.remove(group);
    };
  }, [drawn, index, key, scene, group]);
  if (!drawn) return null;
  return createPortal(
    <FormatContext.Provider value={null}>{children}</FormatContext.Provider>,
    group,
  );
}

/** Stacks a layer in JSX order with no depth test: three breaks a same-plane tie by object id, which follows when a child finished loading, not where it sits. */
export function stackInJsxOrder(root: Object3D): void {
  let order = 0;
  root.traverse((o) => {
    const material = (o as { material?: Material | Material[] }).material;
    if (!material) return;
    o.renderOrder = order++;
    for (const m of Array.isArray(material) ? material : [material]) {
      m.depthTest = false;
      m.depthWrite = false;
    }
  });
}

/** Draws the layer from inside the scene's own render pass: a zero-size mesh sorted just ahead of all content fires `onBeforeRender`, which renders the layer's scene into the current target with the base camera. So it follows the host's visibility on every compositor path (solo, effects, each side of a comparison, each side of a transition) without a pass of its own, and glass refracts it. The layer's scene hangs off the root, invisible, so the export's typeset barrier still walks its text. */
function BackLayer({ children }: { children?: ReactNode }) {
  const root = useThree((s) => s.scene);
  const [layer] = useState(() => {
    const s = new Scene();
    s.visible = false;
    return s;
  });
  const camera = useMemo(() => {
    const pose = baseCameraPose();
    const c = new PerspectiveCamera(pose.fov, 1, 0.1, 1000);
    c.position.set(pose.position[0], pose.position[1], pose.position[2]);
    c.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
    return c;
  }, []);
  useLayoutEffect(() => {
    root.add(layer);
    return () => {
      root.remove(layer);
    };
  }, [root, layer]);
  const geometry = useMemo(() => new BufferGeometry(), []);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ colorWrite: false, depthTest: false, depthWrite: false });
    m.toneMapped = false;
    return m;
  }, []);
  useLayoutEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  const onBeforeRender = useMemo(
    () => (renderer: WebGLRenderer, _scene: unknown, active: unknown) => {
      const main = active as PerspectiveCamera;
      if (main.isPerspectiveCamera && camera.aspect !== main.aspect) {
        camera.aspect = main.aspect;
        camera.updateProjectionMatrix();
      }
      stackInJsxOrder(layer);
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      layer.visible = true;
      renderer.render(layer, camera);
      layer.visible = false;
      renderer.autoClear = autoClear;
    },
    [camera, layer],
  );
  return (
    <>
      <mesh
        geometry={geometry}
        material={material}
        renderOrder={SCREEN_BACK_RENDER_ORDER}
        frustumCulled={false}
        onBeforeRender={onBeforeRender}
      />
      {createPortal(children, layer)}
    </>
  );
}
