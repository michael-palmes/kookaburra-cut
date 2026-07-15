import { create } from "zustand";

/** Which mounted scenes consume the sidecar devices array via `useSceneDevices` (scenes are opaque compiled components, so mount-time reporting is the only ground truth): `DevicesFallback` renders sidecar devices itself only when the scene's TSX doesn't, and the inspector's Add device works on any scene either way. Count-based like textMotionRegistry; registered from a layout effect (never the render path) so the fallback's render gate settles before any frame paints. */
interface DeviceRegistryState {
  consumers: Record<number, number>;
  register: (index: number) => void;
  unregister: (index: number) => void;
}

export const useDeviceRegistry = create<DeviceRegistryState>((set) => ({
  consumers: {},
  register: (index) =>
    set((s) => ({ consumers: { ...s.consumers, [index]: (s.consumers[index] ?? 0) + 1 } })),
  unregister: (index) =>
    set((s) => {
      const n = (s.consumers[index] ?? 0) - 1;
      const consumers = { ...s.consumers };
      if (n <= 0) delete consumers[index];
      else consumers[index] = n;
      return { consumers };
    }),
}));

/** True when the scene at `index` has a mounted `useSceneDevices` consumer. */
export function useSceneConsumesDevices(index: number | undefined): boolean {
  return useDeviceRegistry((s) => index !== undefined && (s.consumers[index] ?? 0) > 0);
}
