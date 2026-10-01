import { type DependencyList, type RefObject, useLayoutEffect, useMemo } from "react";
import type { InstancedMesh, ShaderMaterial } from "three";
import { useFormat } from "../../../../engine/format";
import type { SeededRandom } from "../../../../engine/rng";
import { useTimeline } from "../../../../engine/timeline";
import { lookSeconds } from "./clock";
import {
  createInstanceScratch,
  type InstancePose,
  seededPlacements,
  writeInstanceMatrices,
  writeStaticInstances,
} from "./instanced";
import { createLookMaterial, type LookMaterialSpec, syncLookFrame } from "./material";

/** Look time in seconds on the ABSOLUTE project clock (`globalMs`) times `speed`. Re-renders the look every clock tick, like `useTimeline()`. */
export function useLookTime(speed: number): number {
  const { globalMs } = useTimeline();
  return lookSeconds(globalMs, speed);
}

/** Named look materials, rebuilt when `deps` change (like useMemo), disposed on rebuild and unmount, and kept pinned to the export format's pixel size. Prefer updating uniform values in a layout effect over listing fast-changing values in `deps`. */
export function useLookMaterials<T extends Record<string, LookMaterialSpec>>(
  create: () => T,
  deps: DependencyList,
): { [K in keyof T]: ShaderMaterial } {
  const { width, height } = useFormat();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's deps are the rebuild key, as with useMemo.
  const materials = useMemo(() => {
    const specs = create();
    const out = {} as { [K in keyof T]: ShaderMaterial };
    for (const name of Object.keys(specs) as (keyof T)[]) {
      out[name] = createLookMaterial(specs[name]);
    }
    return out;
  }, [...deps]);
  useLayoutEffect(
    () => () => {
      for (const m of Object.values(materials) as ShaderMaterial[]) m.dispose();
    },
    [materials],
  );
  useLayoutEffect(() => {
    for (const m of Object.values(materials) as ShaderMaterial[]) syncLookFrame(m, width, height);
  }, [materials, width, height]);
  return materials;
}

/** One look material; see useLookMaterials. */
export function useLookMaterial(
  create: () => LookMaterialSpec,
  deps: DependencyList,
): ShaderMaterial {
  return useLookMaterials(() => ({ material: create() }), deps).material;
}

/** Seeded placements (F12), recomputed only when the seed, count or `deps` change. */
export function useSeededPlacements<T>(
  seed: number,
  count: number,
  place: (rand: SeededRandom, index: number) => T,
  deps: DependencyList = [],
): T[] {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `place` is keyed by the caller's deps.
  return useMemo(() => seededPlacements(seed, count, place), [seed, count, ...deps]);
}

/** Writes instance matrices in the commit phase after EVERY render of the look (the clock re-renders it each tick), so the pose is always a pure function of the current time; nothing is allocated per frame. Give the mesh `frustumCulled={false}`: its bounds go stale as instances move. */
export function useInstancedLayout<T>(
  meshRef: RefObject<InstancedMesh | null>,
  items: readonly T[],
  pose: (item: T, index: number, out: InstancePose) => void,
): void {
  const scratch = useMemo(createInstanceScratch, []);
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh) writeInstanceMatrices(mesh, items, pose, scratch);
  });
}

/** Static layout (F12) for shader-driven motion: writes `items` into every mesh once per mesh and items identity, never per frame, and the vertex shader animates each instance from `lookInstanceAnchor()`. Pass several refs for companion meshes that share one layout. `pose` must be a pure function of the item: memoise `items` on whatever changes it. */
export function useStaticInstancedLayout<T>(
  meshRefs: readonly RefObject<InstancedMesh | null>[],
  items: readonly T[],
  pose: (item: T, index: number, out: InstancePose) => void,
): void {
  const scratch = useMemo(createInstanceScratch, []);
  const written = useMemo(() => new WeakMap<InstancedMesh, readonly unknown[]>(), []);
  useLayoutEffect(() => {
    for (const ref of meshRefs) writeStaticInstances(ref.current, items, pose, scratch, written);
  });
}
