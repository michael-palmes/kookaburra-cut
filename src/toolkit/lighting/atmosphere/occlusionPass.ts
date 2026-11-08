import {
  type Camera,
  Color,
  type Material,
  type Mesh,
  type Object3D,
  type Scene,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";

/** Mesh userData flag for anything the atmosphere passes must leave out (the beams themselves, a floor that should not block screen rays). */
export const ATMOS_SKIP = "atmosNoOcclude";

/** Opaque, ordinary content: backgrounds and frame layers (negative render order), translucent parts, troika text and flagged meshes stay out. */
export function occludes(o: Object3D): boolean {
  const mesh = o as Mesh;
  if (!mesh.isMesh) return false;
  if (o.renderOrder < 0 || o.userData[ATMOS_SKIP]) return false;
  if ("_private_text" in o) return false;
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
  return !mats.some((m) => m.transparent);
}

const savedClear = new Color();

/** Draws only what blocks light into `target` with one override material, then puts the renderer, the scene and every hidden mesh back exactly as they were. Runs inside a draw's onBeforeRender, so shadow maps are not re-rendered. */
export function renderOccluders(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  target: WebGLRenderTarget,
  material: Material,
  clear: number,
): void {
  const hidden: Object3D[] = [];
  scene.traverseVisible((o) => {
    if ((o as Mesh).isMesh && !occludes(o)) hidden.push(o);
  });
  for (const o of hidden) o.visible = false;
  const outer = renderer.getRenderTarget();
  const prevOverride = scene.overrideMaterial;
  const prevBackground = scene.background;
  const prevAutoClear = renderer.autoClear;
  const prevShadows = renderer.shadowMap.autoUpdate;
  renderer.getClearColor(savedClear);
  const prevAlpha = renderer.getClearAlpha();
  scene.overrideMaterial = material;
  scene.background = null;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = true;
  renderer.setRenderTarget(target);
  renderer.setClearColor(clear, 1);
  renderer.render(scene, camera);
  renderer.setRenderTarget(outer);
  renderer.setClearColor(savedClear, prevAlpha);
  renderer.autoClear = prevAutoClear;
  renderer.shadowMap.autoUpdate = prevShadows;
  scene.background = prevBackground;
  scene.overrideMaterial = prevOverride;
  for (const o of hidden) o.visible = true;
}
