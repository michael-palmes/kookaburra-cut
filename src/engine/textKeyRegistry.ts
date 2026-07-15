import { create } from "zustand";

/** Which sidecar text keys each mounted scene consumes via `useSceneText` (mount-time reporting, same rationale as deviceRegistry): `TextFallback` renders title/subtitle itself only when the scene's TSX doesn't, and the inspector's Add text seeds the keys the scene actually reads. Count-based per (scene, key); registered from a layout effect so the fallback's render gate settles before any frame paints. A key's entry also carries the mounted primitive's default fill (`colorDefault`, a token or raw hex) when it accepts a sidecar colour override via `textKey`; the Edit-text drill-in shows a colour swatch exactly for those keys. */
interface TextKeyEntry {
  count: number;
  colorDefault?: string;
}

interface TextKeyRegistryState {
  keys: Record<number, Record<string, TextKeyEntry>>;
  register: (index: number, key: string, colorDefault?: string) => void;
  unregister: (index: number, key: string) => void;
}

export const useTextKeyRegistry = create<TextKeyRegistryState>((set) => ({
  keys: {},
  register: (index, key, colorDefault) =>
    set((s) => {
      const prev = s.keys[index]?.[key];
      const entry: TextKeyEntry = {
        count: (prev?.count ?? 0) + 1,
        // A colour-capable mount wins the slot; duplicate mounts (the compositor's A/B pair) agree by construction.
        ...((colorDefault ?? prev?.colorDefault) !== undefined
          ? { colorDefault: colorDefault ?? prev?.colorDefault }
          : {}),
      };
      return { keys: { ...s.keys, [index]: { ...s.keys[index], [key]: entry } } };
    }),
  unregister: (index, key) =>
    set((s) => {
      const scene = { ...s.keys[index] };
      const prev = scene[key];
      const n = (prev?.count ?? 0) - 1;
      if (n <= 0) delete scene[key];
      else scene[key] = { ...prev, count: n };
      const keys = { ...s.keys };
      if (Object.keys(scene).length === 0) delete keys[index];
      else keys[index] = scene;
      return { keys };
    }),
}));

/** True when the scene at `index` has a mounted `useSceneText` consumer for any of `keys`. */
export function useSceneConsumesAnyTextKey(
  index: number | undefined,
  keys: readonly string[],
): boolean {
  return useTextKeyRegistry(
    (s) => index !== undefined && keys.some((k) => (s.keys[index]?.[k]?.count ?? 0) > 0),
  );
}

/** Non-hook read for UI handlers: the text keys the mounted scene consumes. */
export function textKeysConsumedBy(index: number): string[] {
  return Object.keys(useTextKeyRegistry.getState().keys[index] ?? {});
}

/** Non-hook read for UI handlers: each colour-capable text key's mounted default fill (token name or raw hex) for the scene at `index`. Keys absent from the result have no mounted primitive accepting a colour override, so they get no swatch. */
export function textKeyColorDefaults(index: number): Record<string, string> {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(scene)) {
    if (entry.colorDefault !== undefined) out[key] = entry.colorDefault;
  }
  return out;
}
