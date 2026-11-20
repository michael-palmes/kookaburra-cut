import { createTimeline, engine } from "animejs";
import { createContext, useContext, useMemo } from "react";
import type { SceneTime } from "../toolkit/types";
import { type ShutterSample, useClockStore } from "./clock";
import { FPS } from "./format";
import { useSceneContext } from "./sceneContext";

/** How far a subtree's own time travels inside a motion blur shutter: undefined inherits the scene's Objects switch, 0 pins it at the frame instant. */
export const MotionBlurContext = createContext<number | undefined>(undefined);

/** Steps per second a subtree's own time holds at (12 is the hand-made look); undefined runs every frame. */
export const SteppedTimeContext = createContext<number | undefined>(undefined);

/** A stepped clock's time: the frame index counted from `startMs`'s first frame, stepped at a whole `fps`, so every frame of a step shows exactly that step's first frame. Integer steps from the frame index, never a floored float time; a rate of FPS or more, or none, runs every frame. */
export function steppedTimeMs(globalMs: number, startMs: number, fps: number): number {
  const rate = Math.round(fps);
  if (!(rate > 0 && rate < FPS)) return globalMs;
  const frame = Math.round((globalMs * FPS) / 1000);
  const first = Math.ceil((startMs * FPS) / 1000 - 1e-6);
  const step = Math.floor(((frame - first) * rate) / FPS);
  return ((first + Math.ceil((step * FPS) / rate)) * 1000) / FPS;
}

/** A stepping as a scene-local time map, or null when there is none. */
export function steppedLocalMap(
  fps: number | undefined,
  startMs: number,
): ((localMs: number) => number) | null {
  if (fps === undefined) return null;
  return (localMs) => steppedTimeMs(startMs + localMs, startMs, fps) - startMs;
}

/** This subtree's stepping as a scene-local time map, or null when it runs every frame: for planners that sample a consumer's time outside its render. */
export function useSteppedLocalMs(): ((localMs: number) => number) | null {
  const fps = useContext(SteppedTimeContext);
  const startMs = useSceneContext()?.startMs ?? 0;
  return useMemo(() => steppedLocalMap(fps, startMs), [fps, startMs]);
}

/** A consumer's time offset inside a shutter sample: the scene's offset times its scale (undefined takes the scene's Objects amount). */
export function shutterOffsetMs(
  shutter: ShutterSample,
  index: number | undefined,
  scale: number | undefined,
): number {
  if (index === undefined || scale === 0) return 0;
  const sample = shutter[index];
  if (!sample) return 0;
  return sample.dtMs * (scale ?? sample.objects);
}

/** Disables anime.js's requestAnimationFrame main loop so frames advance only when the exporter ticks the clock; call this before a deterministic export run (anime.js v4: `engine.useDefaultMainLoop = false`). One-way by design: nothing in the editor uses the default loop (the one global timeline is autoplay-off and seek-driven), so no path re-enables it. */
export function configureDeterministicEngine(): void {
  (engine as unknown as { useDefaultMainLoop: boolean }).useDefaultMainLoop = false;
}

/** A single global, seekable project timeline (autoplay off); scenes register their tweens as time ranges on this one clock, and both the preview and the exporter drive it with `seek(t)`, so they are pixel-identical by construction. */
export function createGlobalTimeline() {
  return createTimeline({ autoplay: false });
}

/** Reactive scene time for the active scrub position. `localMs` is relative to the enclosing scene's start (supplied by `<SceneHost>` via `SceneContext`); with no scene context it falls back to project time so a lone scene anchored at t=0 keeps `localMs === globalMs` (the v0 contract). `progress` stays project-global per the `SceneTime` type; authors derive scene-local progress from `localMs / scene.durationMs`. Inside a motion blur sample the time moves by the scene's shutter offset times `scale` (default: the `MotionBlurContext`); 0 never moves and never re-renders for a sample. Inside `SteppedTime` the frame instant steps BEFORE that offset, so a held pose blurs around itself and never ghosts into the next step. */
export function useTimeline(scale?: number): SceneTime {
  return useSceneTime(scale, useContext(SteppedTimeContext));
}

/** `useTimeline` at the full frame rate even inside a stepped subtree, for what has to track the camera. */
export function useFrameTimeline(scale?: number): SceneTime {
  return useSceneTime(scale, undefined);
}

function useSceneTime(scale: number | undefined, stepFps: number | undefined): SceneTime {
  const frameMs = useClockStore((s) => s.currentMs);
  const totalMs = useClockStore((s) => s.durationMs);
  const scene = useSceneContext();
  const inherited = useContext(MotionBlurContext);
  const index = scene?.index;
  const own = scale ?? inherited;
  const offsetMs = useClockStore((s) => shutterOffsetMs(s.shutter, index, own));
  const startMs = scene?.startMs ?? 0;
  const heldMs = stepFps === undefined ? frameMs : steppedTimeMs(frameMs, startMs, stepFps);
  const currentMs = offsetMs === 0 ? heldMs : heldMs + offsetMs;
  const progress = totalMs <= 0 ? 0 : Math.min(1, Math.max(0, currentMs / totalMs));
  return { localMs: currentMs - startMs, globalMs: currentMs, progress };
}
