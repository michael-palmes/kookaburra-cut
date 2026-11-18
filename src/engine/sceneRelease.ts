import { useLayoutEffect, useRef } from "react";
import type { Light, LightShadow } from "three";
import { useSceneContext } from "./sceneContext";
import { getSceneHosts } from "./sceneHostRegistry";
import type { SceneSlot } from "./sceneTimeline";

/** GPU memory a scene owns that an export lets go once the film has moved past it (docs/determinism.md, "Memory probe"). Owners register a release under their scene's index; the export loop calls it when no later frame can draw the scene. A released owner re-allocates on its next draw, so a later run or the preview draws as before. */

type Release = () => void;

const owners = new Map<number, Set<Release>>();
let enabled = true;

export function registerSceneRelease(index: number, release: Release): () => void {
  const set = owners.get(index) ?? new Set<Release>();
  owners.set(index, set);
  set.add(release);
  return () => {
    set.delete(release);
    if (set.size === 0 && owners.get(index) === set) owners.delete(index);
  };
}

/** Calls every release scene `index` registered (both comparison sides share the index) and lets its lights' shadow maps go, which three clears and redraws on every draw. */
export function releaseScene(index: number): void {
  if (!enabled) return;
  for (const release of owners.get(index) ?? []) release();
  for (const host of getSceneHosts()) {
    if (host.index !== index) continue;
    host.group.traverse((object) => {
      const light = object as Light & { shadow?: LightShadow };
      if (light.isLight && light.shadow?.map) light.shadow.dispose();
    });
  }
}

/** The memory probe's `scene-release=off` lever; nothing else changes it. */
export function setSceneReleaseEnabled(on: boolean): void {
  enabled = on;
}

/** The scenes a frame at `tMs` leaves behind for good when frames only step forward: every slot that ended by `tMs`, save the last (it holds the film's end frame). */
export function scenesPassed(slots: readonly SceneSlot[], tMs: number): number[] {
  const passed: number[] = [];
  for (let i = 0; i < slots.length - 1; i++) {
    if (slots[i].endMs <= tMs) passed.push(slots[i].index);
  }
  return passed;
}

/** Registers `release` for the enclosing scene; a no-op outside one. The latest callback runs, so it may close over render state. */
export function useSceneRelease(release: Release): void {
  const index = useSceneContext()?.index;
  const latest = useRef(release);
  latest.current = release;
  useLayoutEffect(() => {
    if (index === undefined) return;
    return registerSceneRelease(index, () => latest.current());
  }, [index]);
}
