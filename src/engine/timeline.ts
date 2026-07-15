import { createTimeline, engine } from "animejs";
import type { SceneTime } from "../toolkit/types";
import { useClockStore } from "./clock";
import { useSceneContext } from "./sceneContext";

/** Disables anime.js's requestAnimationFrame main loop so frames advance only when the exporter ticks the clock; call this before a deterministic export run (anime.js v4: `engine.useDefaultMainLoop = false`). */
export function configureDeterministicEngine(): void {
  (engine as unknown as { useDefaultMainLoop: boolean }).useDefaultMainLoop = false;
}

/** A single global, seekable project timeline (autoplay off); scenes register their tweens as time ranges on this one clock, and both the preview and the exporter drive it with `seek(t)`, so they are pixel-identical by construction. */
export function createGlobalTimeline() {
  return createTimeline({ autoplay: false });
}

/** Reactive scene time for the active scrub position. `localMs` is relative to the enclosing scene's start (supplied by `<SceneHost>` via `SceneContext`); with no scene context it falls back to project time so a lone scene anchored at t=0 keeps `localMs === globalMs` (the v0 contract). `progress` stays project-global per the `SceneTime` type; authors derive scene-local progress from `localMs / scene.durationMs`. */
export function useTimeline(): SceneTime {
  const currentMs = useClockStore((s) => s.currentMs);
  const totalMs = useClockStore((s) => s.durationMs);
  const scene = useSceneContext();
  const startMs = scene?.startMs ?? 0;
  const progress = totalMs <= 0 ? 0 : Math.min(1, Math.max(0, currentMs / totalMs));
  return { localMs: currentMs - startMs, globalMs: currentMs, progress };
}
