import { useGLTF } from "@react-three/drei";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { warmObjectAsset } from "./registry";

/** Export barrier for staged objects (the preloadHeroModels shape over a DYNAMIC id set): resolve every referenced object id into the warm asset cache, then fetch + parse each distinct glb so frame 0 never captures a still-loading object; unknown ids resolve to nothing and render nothing, deterministically. */
export async function preloadSceneObjects(
  sceneDocs: readonly (SceneDoc | undefined)[],
): Promise<void> {
  const ids = new Set<string>();
  for (const doc of sceneDocs) {
    for (const spec of doc?.objects ?? []) ids.add(spec.objectId);
  }
  if (ids.size === 0) return;
  const urls = new Set<string>();
  for (const id of ids) {
    const asset = await warmObjectAsset(id);
    if (asset) urls.add(asset.glbUrl);
  }
  const loader = new GLTFLoader();
  await Promise.all(
    [...urls].map(async (url) => {
      useGLTF.preload(url);
      await loader.loadAsync(url);
    }),
  );
}
