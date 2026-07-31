import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { warmObjectAsset } from "./registry";

/** Staged objects keep their OWN gltf suspense cache (never drei's): `StagedObject` and this barrier resolve on the SAME loader promise, so "barrier done" provably means "component can mount synchronously". Relying on `useGLTF.preload` left a window where drei's separate cache entry was still parsing and a capture read a half-mounted frame (the mashed-card bug). */
const gltfCache = new Map<string, GLTF>();
const gltfInflight = new Map<string, Promise<GLTF>>();

function loadObjectGltf(url: string): Promise<GLTF> {
  let inflight = gltfInflight.get(url);
  if (!inflight) {
    inflight = new GLTFLoader().loadAsync(url).then((gltf) => {
      gltfCache.set(url, gltf);
      gltfInflight.delete(url);
      return gltf;
    });
    gltfInflight.set(url, inflight);
  }
  return inflight;
}

/** Suspense read: warm-cache hits return synchronously; cold reads throw the in-flight promise. */
export function readObjectGltf(url: string): GLTF {
  const cached = gltfCache.get(url);
  if (cached) return cached;
  throw loadObjectGltf(url);
}

/** Export/capture barrier for staged objects over a DYNAMIC id set: resolve every referenced object id into the warm asset cache, then fetch + parse each distinct glb into the object gltf cache, so frame 0 (or a preview-card capture) never reads a still-loading object; unknown ids resolve to nothing and render nothing, deterministically. */
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
  await Promise.all([...urls].map((url) => loadObjectGltf(url)));
}
