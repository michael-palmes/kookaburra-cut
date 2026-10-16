import { createTimeline, engine } from "animejs";
import { createContext, useContext } from "react";
import type { SceneTime } from "../toolkit/types";
import { type ShutterSample, useClockStore } from "./clock";
import { useSceneContext } from "./sceneContext";

/** How far a subtree's own time travels inside a motion blur shutter: undefined inherits the scene's Objects switch, 0 pins it at the frame instant. */
export const MotionBlurContext = createContext<number | undefined>(undefined);

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

/** Reactive scene time for the active scrub position. `localMs` is relative to the enclosing scene's start (supplied by `<SceneHost>` via `SceneContext`); with no scene context it falls back to project time so a lone scene anchored at t=0 keeps `localMs === globalMs` (the v0 contract). `progress` stays project-global per the `SceneTime` type; authors derive scene-local progress from `localMs / scene.durationMs`. Inside a motion blur sample the time moves by the scene's shutter offset times `scale` (default: the `MotionBlurContext`); 0 never moves and never re-renders for a sample. */
export function useTimeline(scale?: number): SceneTime {
  const frameMs = useClockStore((s) => s.currentMs);
  const totalMs = useClockStore((s) => s.durationMs);
  const scene = useSceneContext();
  const inherited = useContext(MotionBlurContext);
  const index = scene?.index;
  const own = scale ?? inherited;
  const offsetMs = useClockStore((s) => shutterOffsetMs(s.shutter, index, own));
  const currentMs = offsetMs === 0 ? frameMs : frameMs + offsetMs;
  const startMs = scene?.startMs ?? 0;
  const progress = totalMs <= 0 ? 0 : Math.min(1, Math.max(0, currentMs / totalMs));
  return { localMs: currentMs - startMs, globalMs: currentMs, progress };
}
