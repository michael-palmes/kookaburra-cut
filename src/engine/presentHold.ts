/** Present-mode hold clamp: a present window pins a holding scene's staged text/group time at its hold point so authored outros never fire mid-hold. The map is only ever written from src/present code, so the editor and export realms read a permanent passthrough. */

import { useSyncExternalStore } from "react";
import { useSceneContext } from "./sceneContext";

let holds: ReadonlyMap<number, number> = new Map();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Pins (or clears, with null) a scene's staged-animation time at holdMs. */
export function setSceneHold(sceneIndex: number, holdMs: number | null): void {
  const next = new Map(holds);
  if (holdMs === null) next.delete(sceneIndex);
  else next.set(sceneIndex, holdMs);
  holds = next;
  notify();
}

export function clearSceneHolds(): void {
  if (holds.size === 0) return;
  holds = new Map();
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The scene-local time staged primitives animate from: the raw timeline unless this scene is held. */
export function useHeldLocalMs(rawLocalMs: number): number {
  const sceneIndex = useSceneContext()?.index;
  const holdMs = useSyncExternalStore(subscribe, () =>
    sceneIndex === undefined ? null : (holds.get(sceneIndex) ?? null),
  );
  return holdMs === null ? rawLocalMs : Math.min(rawLocalMs, holdMs);
}
