import { createContext } from "react";
import type { MeshBasicMaterial } from "three";

/** Inside a `Device`: each display's material, holding what it shows this frame (`map`, power in `color`, the crop in `userData.screenUvMap`). */
export const DeviceDisplaysContext = createContext<{
  main: MeshBasicMaterial;
  cover: MeshBasicMaterial;
} | null>(null);
