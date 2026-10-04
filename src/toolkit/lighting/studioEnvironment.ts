import { useThree } from "@react-three/fiber";
import { useLayoutEffect } from "react";
import {
  Color,
  CubeCamera,
  DoubleSide,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  type Texture,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
} from "three";

/** The lit set's procedural environment (Device, DeviceMockup, HeroObject). drei's `<Environment frames={1}>` re-ran its cube render and PMREM on every parent re-render, i.e. every clock tick per mounted primitive, and those rebuilds lit a few highlight pixels differently from the mount-time build (a cold frame-0 flake). Built once per renderer here and shared; see docs/determinism.md. */
const built = new WeakMap<WebGLRenderer, Texture>();

/** drei Lightformer `form="rect"`: a unit plane, white × intensity, unlit and never tone mapped, facing the origin. */
function studioScene(): Scene {
  const scene = new Scene();
  const rect = (intensity: number, position: [number, number, number], scale: number) => {
    const mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        color: new Color(intensity, intensity, intensity),
        side: DoubleSide,
        toneMapped: false,
      }),
    );
    mesh.position.set(...position);
    mesh.scale.setScalar(scale);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };
  rect(2, [0, 3, 4], 8);
  rect(1.2, [-4, 1, 2], 5);
  rect(1, [4, -1, 3], 5);
  return scene;
}

/** The shared studio environment PMREM for this renderer, built on first call. */
export function studioEnvironment(gl: WebGLRenderer): Texture {
  const cached = built.get(gl);
  if (cached) return cached;
  const scene = studioScene();
  const cube = new WebGLCubeRenderTarget(256);
  cube.texture.type = HalfFloatType;
  const camera = new CubeCamera(0.1, 1000, cube);
  scene.add(camera);
  const autoClear = gl.autoClear;
  gl.autoClear = true;
  camera.update(gl, scene);
  gl.autoClear = autoClear;
  const pmrem = new PMREMGenerator(gl);
  const texture = pmrem.fromCubemap(cube.texture).texture;
  pmrem.dispose();
  cube.dispose();
  scene.traverse((obj) => {
    if (obj instanceof Mesh) {
      obj.geometry.dispose();
      obj.material.dispose();
    }
  });
  built.set(gl, texture);
  return texture;
}

interface Hold {
  count: number;
  restore: () => void;
}
const holds = new WeakMap<Scene, Hold>();

/** Puts `texture` on the root scene while any lit primitive holds it, restoring the previous values when the last lets go. */
export function holdStudioEnvironment(scene: Scene, texture: Texture): () => void {
  const hold = holds.get(scene);
  if (hold) {
    hold.count++;
  } else {
    const prev = {
      environment: scene.environment,
      intensity: scene.environmentIntensity,
      rotation: scene.environmentRotation.clone(),
    };
    scene.environment = texture;
    scene.environmentIntensity = 1;
    scene.environmentRotation.set(0, 0, 0);
    holds.set(scene, {
      count: 1,
      restore: () => {
        scene.environment = prev.environment;
        scene.environmentIntensity = prev.intensity;
        scene.environmentRotation.copy(prev.rotation);
      },
    });
  }
  return () => {
    const current = holds.get(scene);
    if (!current || --current.count > 0) return;
    holds.delete(scene);
    current.restore();
  };
}

/** Mounts the shared studio environment while `active`; deps are stable, so a per-frame re-render never touches it. */
export function useStudioEnvironment(active: boolean): void {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useLayoutEffect(
    () => (active ? holdStudioEnvironment(scene, studioEnvironment(gl)) : undefined),
    [active, gl, scene],
  );
}
