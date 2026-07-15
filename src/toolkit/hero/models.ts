import { useGLTF } from "@react-three/drei";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { phoneModelUrl } from "../device/modelUrl";

/** Toolkit-shipped hero models: like `device/models.ts`, the `HeroObject` `model` prop is a NAME not a path, so geometry ships with the toolkit and names stay asset-agnostic (the glb behind a name can swap without touching projects); `handset` currently points at the same bundled glb as DeviceMockup, so the trademark caveat in src/assets/models/README.md applies. */
export type HeroModelName = "handset";

export const HERO_MODELS: Record<HeroModelName, string> = {
  handset: phoneModelUrl,
};

/** Barrier: awaits every bundled hero model fetched + parsed before frame 0 and warms drei's `useGLTF` cache since the export loop does not await Suspense; shares a URL with `preloadDeviceModels` today, so this is effectively free. */
export async function preloadHeroModels(): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    Object.values(HERO_MODELS).map(async (url) => {
      useGLTF.preload(url);
      await loader.loadAsync(url);
    }),
  );
}
