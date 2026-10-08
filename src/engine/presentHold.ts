/** Present-mode hold clamp: a holding scene's staged text/group time is pinned at its hold point so authored outros never fire mid-hold. Written only by src/present and the stills exporter (which holds automatic stills where Present would, then clears before export ends), so the editor and video export read a permanent passthrough. */

import { useSyncExternalStore } from "react";
import { useSceneContext } from "./sceneContext";

let holds: ReadonlyMap<number, number> = new Map();
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
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

/** Replaces every hold at once (one notify); returns the new version for a commit barrier to wait on. */
export function replaceSceneHolds(map: ReadonlyMap<number, number>): number {
  holds = new Map(map);
  notify();
  return version;
}

export function clearSceneHolds(): void {
  if (holds.size === 0) return;
  holds = new Map();
  notify();
}

/** Bumped on every change to the hold map. */
export function sceneHoldsVersion(): number {
  return version;
}

export function hasSceneHolds(): boolean {
  return holds.size > 0;
}

export function subscribeSceneHolds(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The scene-local time staged primitives animate from: the raw timeline unless this scene is held. */
export function useHeldLocalMs(rawLocalMs: number): number {
  const sceneIndex = useSceneContext()?.index;
  const holdMs = useSyncExternalStore(subscribeSceneHolds, () =>
    sceneIndex === undefined ? null : (holds.get(sceneIndex) ?? null),
  );
  return holdMs === null ? rawLocalMs : Math.min(rawLocalMs, holdMs);
}
