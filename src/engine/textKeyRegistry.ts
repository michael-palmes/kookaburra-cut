import { create } from "zustand";
import type { TextAnimationSpec } from "../theme/tokens";
import type { VirtualManagedTextRegistration } from "./managedText";
import type { SceneManagedTextItemType } from "./sceneDocSchema";

export interface TextKeyResolvedStyle {
  color?: string;
  font?: string;
  size?: number;
  offsetX?: number;
  offsetY?: number;
  lineHeight?: number;
  rotationDeg?: number;
}

export interface TextKeyMountRegistration {
  resolvedText?: string;
  managedType?: SceneManagedTextItemType;
  icon?: string;
  colorDefault?: string;
  styleCapable?: boolean;
  style?: TextKeyResolvedStyle;
  codedMotion?: TextAnimationSpec;
}

interface TextKeyEntry {
  count: number;
  mounts: Record<string, TextKeyMountRegistration>;
  colorDefault?: string;
  styleCapable?: boolean;
  resolvedText?: string;
  managedType?: SceneManagedTextItemType;
  icon?: string;
  style?: TextKeyResolvedStyle;
  codedMotion?: TextAnimationSpec;
}

interface TextKeyRegistryState {
  keys: Record<number, Record<string, TextKeyEntry>>;
  register: (
    index: number,
    key: string,
    mountId: string,
    registration?: TextKeyMountRegistration,
  ) => void;
  unregister: (index: number, key: string, mountId: string) => void;
}

function mergedEntry(mounts: Record<string, TextKeyMountRegistration>): TextKeyEntry {
  const values = Object.values(mounts);
  const colorDefault = values.find((value) => value.colorDefault !== undefined)?.colorDefault;
  const resolvedText = values.find((value) => value.resolvedText !== undefined)?.resolvedText;
  const managedType = values.find((value) => value.managedType !== undefined)?.managedType;
  const icon = values.find((value) => value.icon !== undefined)?.icon;
  const style = values.find((value) => value.style !== undefined)?.style;
  const codedMotion = values.find((value) => value.codedMotion !== undefined)?.codedMotion;
  return {
    count: values.length,
    mounts,
    ...(colorDefault !== undefined ? { colorDefault } : {}),
    ...(values.some((value) => value.styleCapable) ? { styleCapable: true } : {}),
    ...(resolvedText !== undefined ? { resolvedText } : {}),
    ...(managedType !== undefined ? { managedType } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(codedMotion !== undefined ? { codedMotion } : {}),
  };
}

/** Mounted text metadata is editor-only. Export never reads this store. */
export const useTextKeyRegistry = create<TextKeyRegistryState>((set) => ({
  keys: {},
  register: (index, key, mountId, registration = {}) =>
    set((state) => {
      const previous = state.keys[index]?.[key];
      const mounts = { ...previous?.mounts, [mountId]: registration };
      return {
        keys: {
          ...state.keys,
          [index]: { ...state.keys[index], [key]: mergedEntry(mounts) },
        },
      };
    }),
  unregister: (index, key, mountId) =>
    set((state) => {
      const scene = { ...state.keys[index] };
      const previous = scene[key];
      if (!previous) return state;
      const mounts = { ...previous.mounts };
      delete mounts[mountId];
      if (Object.keys(mounts).length === 0) delete scene[key];
      else scene[key] = mergedEntry(mounts);
      const keys = { ...state.keys };
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
    (state) =>
      index !== undefined && keys.some((key) => (state.keys[index]?.[key]?.count ?? 0) > 0),
  );
}

/** Non-hook read for UI handlers: the text keys the mounted scene consumes. */
export function textKeysConsumedBy(index: number): string[] {
  return Object.keys(useTextKeyRegistry.getState().keys[index] ?? {});
}

/** Non-hook read for UI handlers: each colour-capable text key's mounted default fill. */
export function textKeyColorDefaults(index: number): Record<string, string> {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(scene)) {
    if (entry.colorDefault !== undefined) out[key] = entry.colorDefault;
  }
  return out;
}

/** Non-hook read for UI handlers: the text keys whose mounted primitive accepts style overrides. */
export function textKeyStyleCapable(index: number): Set<string> {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  return new Set(
    Object.entries(scene)
      .filter(([, entry]) => entry.styleCapable === true)
      .map(([key]) => key),
  );
}

/** Exact virtual takeover inputs from mounted code-owned text, in deterministic key order. */
export function virtualManagedTextRegistrations(index: number): VirtualManagedTextRegistration[] {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  return Object.entries(scene)
    .filter(([, entry]) => entry.resolvedText !== undefined || entry.icon !== undefined)
    .map(([key, entry]) => ({
      key,
      text: entry.resolvedText ?? "",
      ...(entry.managedType ? { type: entry.managedType } : {}),
      ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
      ...(entry.style ? { style: structuredClone(entry.style) } : {}),
      ...(entry.codedMotion ? { motion: structuredClone(entry.codedMotion) } : {}),
    }));
}

/** Stable names for the mounted lines whose own TSX motion can outrank inspector motion. */
export function codedTextMotionNames(index: number): string[] {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  return Object.entries(scene)
    .filter(([, entry]) => entry.codedMotion !== undefined)
    .map(([key]) =>
      key
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
    );
}
