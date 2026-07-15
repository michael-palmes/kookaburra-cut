import { useGLTF } from "@react-three/drei";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { phoneModelUrl } from "./modelUrl";

/** Toolkit-shipped device models: `DeviceMockup`'s `model` prop is a NAME (not a path), so geometry ships with the toolkit and is bundled via Vite's `?url` (fingerprinted, survives the packaged build); regenerate the glb with `pnpm assets:phone`. */
export type DeviceModelName = "phone-generic";

/** Material name of the display mesh inside the bundled models (swapped to show the screen). */
export const SCREEN_MATERIAL = "SCREEN";

/** Nodes baked into a source model that should not render, as three.js sanitises them (spaces to underscores, dots stripped): the studio backdrop plates ("BG Plane"/"Bg"/"Cube") and the MacBook's render-only view blocker. */
export const HIDDEN_NODES = new Set(["BG_Plane", "Bg", "Cube", "View_Blocker001"]);

/** Maps a device model name to its bundled, deterministic glTF URL. */
export const DEVICE_MODELS: Record<DeviceModelName, string> = {
  "phone-generic": phoneModelUrl,
};

/** Barrier: awaits every bundled device model fetched + parsed before frame 0 and warms drei's `useGLTF` cache, since the export loop does not await Suspense. See docs/determinism.md. */
export async function preloadDeviceModels(): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    Object.values(DEVICE_MODELS).map(async (url) => {
      useGLTF.preload(url); // warm drei's suspense cache (no Draco decoder needed, see script)
      await loader.loadAsync(url); // awaitable barrier: guarantees fetched + parsed
    }),
  );
}
