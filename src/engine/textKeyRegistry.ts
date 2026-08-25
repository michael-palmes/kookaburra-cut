import { create } from "zustand";
import type { TextAnimationSpec, TextLookSpec } from "../theme/tokens";
import type {
  ManagedTextRenderRole,
  ManagedTextStyleControl,
  VirtualManagedTextRegistration,
} from "./managedText";
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
  codedLook?: TextLookSpec;
  /** Style controls this mount ignores, so the drill hides them; absent shows everything. */
  inertStyleControls?: readonly ManagedTextStyleControl[];
  /** Only scene-level registrations may become rows in a managed takeover. */
  managedTextRole?: ManagedTextRenderRole;
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
  codedLook?: TextLookSpec;
  inertStyleControls?: readonly ManagedTextStyleControl[];
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
  const codedLook = values.find((value) => value.codedLook !== undefined)?.codedLook;
  const inertStyleControls = values.find(
    (value) => value.inertStyleControls !== undefined,
  )?.inertStyleControls;
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
    ...(codedLook !== undefined ? { codedLook } : {}),
    ...(inertStyleControls !== undefined ? { inertStyleControls } : {}),
  };
}

function sceneOwnedEntry(entry: TextKeyEntry): TextKeyEntry {
  return mergedEntry(
    Object.fromEntries(
      Object.entries(entry.mounts).filter(
        ([, registration]) =>
          registration.managedTextRole === undefined || registration.managedTextRole === "scene",
      ),
    ),
  );
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

/** True only for code-owned scene mounts, excluding embedded and host-managed renderers. */
export function sceneOwnsAnyTextKey(
  entries: Record<string, TextKeyEntry> | undefined,
  keys: readonly string[],
): boolean {
  return keys.some((key) => {
    const entry = entries?.[key];
    return entry ? sceneOwnedEntry(entry).count > 0 : false;
  });
}

export function useSceneOwnsAnyTextKey(
  index: number | undefined,
  keys: readonly string[],
): boolean {
  return useTextKeyRegistry((state) =>
    index === undefined ? false : sceneOwnsAnyTextKey(state.keys[index], keys),
  );
}

/** Non-hook read for UI handlers: the text keys the mounted scene consumes. */
export function textKeysConsumedBy(index: number): string[] {
  return Object.keys(useTextKeyRegistry.getState().keys[index] ?? {});
}

/** Mounted code-owned scene keys only, excluding host-managed and embedded renderers. */
export function sceneTextKeysConsumedBy(index: number): string[] {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  return Object.entries(scene)
    .filter(([, entry]) => sceneOwnedEntry(entry).count > 0)
    .map(([key]) => key);
}

/** Keys mounted only as embedded or managed composition text. */
export function nonSceneTextKeys(index: number): string[] {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  return Object.entries(scene)
    .filter(([, entry]) => entry.count > 0 && sceneOwnedEntry(entry).count === 0)
    .map(([key]) => key);
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
    .map(([key, entry]): VirtualManagedTextRegistration | null => {
      const sceneEntry = sceneOwnedEntry(entry);
      if (sceneEntry.resolvedText === undefined && sceneEntry.icon === undefined) return null;
      return {
        key,
        text: sceneEntry.resolvedText ?? "",
        ...(sceneEntry.managedType ? { type: sceneEntry.managedType } : {}),
        ...(sceneEntry.icon !== undefined ? { icon: sceneEntry.icon } : {}),
        ...(sceneEntry.style ? { style: structuredClone(sceneEntry.style) } : {}),
        ...(sceneEntry.codedMotion ? { motion: structuredClone(sceneEntry.codedMotion) } : {}),
        ...(sceneEntry.codedLook ? { look: structuredClone(sceneEntry.codedLook) } : {}),
        ...(sceneEntry.inertStyleControls
          ? { inertStyleControls: [...sceneEntry.inertStyleControls] }
          : {}),
      } satisfies VirtualManagedTextRegistration;
    })
    .filter((entry): entry is VirtualManagedTextRegistration => entry !== null);
}

function titleCaseKey(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Stable names for the mounted lines whose own TSX motion can outrank inspector motion. */
export function codedTextMotionNames(index: number): string[] {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  return Object.entries(scene)
    .filter(([, entry]) => sceneOwnedEntry(entry).codedMotion !== undefined)
    .map(([key]) => titleCaseKey(key));
}

/** Stable names for the mounted lines whose own TSX look can outrank the inspector's text style. */
export function codedTextLookNames(index: number): string[] {
  const scene = useTextKeyRegistry.getState().keys[index] ?? {};
  return Object.entries(scene)
    .filter(([, entry]) => sceneOwnedEntry(entry).codedLook !== undefined)
    .map(([key]) => titleCaseKey(key));
}
