import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** One PNG thumbnail for an imported object glb: a detached plain-three render (no r3f, no shared canvas, no clock), so importing can never disturb the live preview or the export path. Best effort: callers treat a null as "no thumbnail yet", the picker degrades to a glyph card. */
export async function renderObjectThumbnail(glbUrl: string, size = 512): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  let renderer: WebGLRenderer | null = null;
  try {
    const gltf = await new GLTFLoader().loadAsync(glbUrl);
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = SRGBColorSpace;

    const scene = new Scene();
    scene.background = new Color("#f4f6f8");
    scene.add(new AmbientLight(0xffffff, 1.1));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.8);
    fill.position.set(-4, 1, 2);
    scene.add(fill);

    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(root);
    const centre = box.getCenter(new Vector3());
    const extent = box.getSize(new Vector3()).length() || 1;
    root.position.sub(centre);
    root.rotation.y = (18 * Math.PI) / 180;
    scene.add(root);

    const camera = new PerspectiveCamera(35, 1, extent / 100, extent * 10);
    camera.position.set(0, extent * 0.18, extent * 1.05);
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch (e) {
    console.warn("[objects] thumbnail render failed:", e);
    return null;
  } finally {
    renderer?.dispose();
  }
}
