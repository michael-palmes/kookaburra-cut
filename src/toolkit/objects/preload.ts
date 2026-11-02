import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { type ResolvedObjectAsset, warmObjectAsset } from "./registry";

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

/** The in-flight loads of objects placed directly in TSX, which no sidecar names ahead of time. */
const usageLoads = new Set<Promise<unknown>>();

/** Whether a TSX-placed object has landed: its asset when both reads would come back synchronously, null when the id can't resolve (it renders nothing), undefined while either is still on its way. */
export function peekUsedObject(id: string): ResolvedObjectAsset | null | undefined {
  const asset = usedAssets.get(id);
  if (asset === undefined) return undefined;
  if (asset === null) return null;
  return gltfCache.has(asset.glbUrl) ? asset : undefined;
}

const usedAssets = new Map<string, ResolvedObjectAsset | null>();
const usedInflight = new Map<string, Promise<void>>();

/** Loads an object a scene placed by id, once: never suspends, since a mid-film first use would otherwise blank every scene behind the shared boundary. A failed glb degrades to nothing, like an unknown id. */
export function loadUsedObject(id: string): Promise<void> {
  let job = usedInflight.get(id);
  if (!job) {
    job = (async () => {
      try {
        const asset = await warmObjectAsset(id);
        if (asset) await loadObjectGltf(asset.glbUrl);
        usedAssets.set(id, asset ?? null);
      } catch (e) {
        console.warn(`[objects] object "${id}" failed to load:`, e);
        usedAssets.set(id, null);
      }
    })();
    usedInflight.set(id, job);
    usageLoads.add(job);
    void job.finally(() => usageLoads.delete(job as Promise<void>));
  }
  return job;
}

/** The capture barrier for TSX-placed objects: resolves once none is still loading. A real wait, not a spin, because a glb can outlast the text-settle spin bound. */
export async function settleUsedObjects(): Promise<void> {
  while (usageLoads.size > 0) await Promise.all(usageLoads);
}
