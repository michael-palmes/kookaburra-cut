import { useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import type { ThemeBackdrop } from "../theme/tokens";
import type { DeviceFloorY } from "../toolkit/device/worldAnchor";
import { getSceneHosts, sceneHostRegistryRevision, subscribeSceneHosts } from "./sceneHostRegistry";

/** Which mounted scenes stage a backdrop, and of what resolved type: the unified Background editor reads this to warn that an image/video background will sit hidden behind world-space staging, and the layered-screenshot stack reads it to keep its fit above a staged cyc floor (scenes are opaque compiled components, so mount-time reporting is the only ground truth). Count-based like textMotionRegistry; registered from inside the canvas (an effect, never the render path), so it settles with the mount and is identical across export runs by construction. */
export interface SceneStageRegistryEntry {
  count: number;
  backdropType: ThemeBackdrop["type"];
  floorY: number | null;
}

export interface SceneStageRegistration {
  index: number;
  side?: "b";
  backdropType: ThemeBackdrop["type"];
  floorY: number | null;
}

interface StageRegistryState {
  registrations: Record<string, SceneStageRegistration>;
  /** Any mounted side, retained for warnings about obscured fixed backgrounds. */
  stages: Record<number, SceneStageRegistryEntry>;
  /** Primary scene hosts only, used by camera bindings. */
  primaryStages: Record<number, SceneStageRegistryEntry>;
  register: (key: string, registration: SceneStageRegistration) => void;
  unregister: (key: string) => void;
}

function deriveStageEntries(
  registrations: Readonly<Record<string, SceneStageRegistration>>,
  primaryOnly: boolean,
): Record<number, SceneStageRegistryEntry> {
  const grouped = new Map<number, SceneStageRegistration[]>();
  for (const registration of Object.values(registrations)) {
    if (primaryOnly && registration.side !== undefined) continue;
    const group = grouped.get(registration.index) ?? [];
    group.push(registration);
    grouped.set(registration.index, group);
  }
  const entries: Record<number, SceneStageRegistryEntry> = {};
  for (const [index, group] of grouped) {
    const selected =
      group.find((entry) => entry.side === undefined && entry.backdropType !== "none") ??
      group.find((entry) => entry.backdropType !== "none") ??
      group.find((entry) => entry.side === undefined) ??
      group[0];
    entries[index] = {
      count: group.length,
      backdropType: selected.backdropType,
      floorY: selected.floorY,
    };
  }
  return entries;
}

export const useStageRegistry = create<StageRegistryState>((set) => ({
  registrations: {},
  stages: {},
  primaryStages: {},
  register: (key, registration) =>
    set((s) => {
      const registrations = { ...s.registrations, [key]: registration };
      return {
        registrations,
        stages: deriveStageEntries(registrations, false),
        primaryStages: deriveStageEntries(registrations, true),
      };
    }),
  unregister: (key) =>
    set((s) => {
      if (!s.registrations[key]) return s;
      const registrations = { ...s.registrations };
      delete registrations[key];
      return {
        registrations,
        stages: deriveStageEntries(registrations, false),
        primaryStages: deriveStageEntries(registrations, true),
      };
    }),
}));

/** The resolved backdrop type of the scene's mounted stage, or null when the scene mounts no `SceneStage` at all. */
export function useSceneStageBackdrop(index: number): ThemeBackdrop["type"] | null {
  return useStageRegistry((s) => s.stages[index]?.backdropType ?? null);
}

/** The backdrop mounted in one concrete scene host, keeping comparison A and B independent. */
export function useSceneHostStageBackdrop(
  index: number | undefined,
  side: "b" | undefined,
): ThemeBackdrop["type"] | null {
  return useStageRegistry((state) => {
    if (index === undefined) return null;
    const registrations = Object.values(state.registrations).filter(
      (registration) => registration.index === index && registration.side === side,
    );
    return (
      registrations.find((registration) => registration.backdropType !== "none")?.backdropType ??
      registrations[0]?.backdropType ??
      null
    );
  });
}

export function resolveSceneStageFloorSnapshot(
  sceneCount: number,
  stages: Readonly<Record<number, SceneStageRegistryEntry>>,
  mountedSceneIndexes: Iterable<number>,
): DeviceFloorY[] {
  const mounted = new Set(mountedSceneIndexes);
  return Array.from({ length: sceneCount }, (_, index) => {
    if (!mounted.has(index)) return undefined;
    return stages[index]?.floorY ?? null;
  });
}

function mountedPrimarySceneIndexes(): number[] {
  return getSceneHosts()
    .filter((host) => host.side === undefined)
    .map((host) => host.index);
}

/** Snapshot mounted floors after a commit barrier. Missing mounted stages are confirmed as no-floor. */
export function snapshotSceneStageFloors(sceneCount: number): DeviceFloorY[] {
  return resolveSceneStageFloorSnapshot(
    sceneCount,
    useStageRegistry.getState().primaryStages,
    mountedPrimarySceneIndexes(),
  );
}

/** Reactive preview floors: unknown before a host mounts, null once that scene confirms no stage. */
export function useSceneStageFloors(sceneCount: number): DeviceFloorY[] {
  const stages = useStageRegistry((state) => state.primaryStages);
  const hostRevision = useSyncExternalStore(
    subscribeSceneHosts,
    sceneHostRegistryRevision,
    sceneHostRegistryRevision,
  );
  return useMemo(() => {
    void hostRevision;
    return resolveSceneStageFloorSnapshot(sceneCount, stages, mountedPrimarySceneIndexes());
  }, [sceneCount, stages, hostRevision]);
}

/** The mounted stage floor, null for a confirmed no-floor scene, or undefined before mount. */
export function useSceneStageFloorY(index: number): DeviceFloorY {
  return useSceneStageFloors(index + 1)[index];
}
