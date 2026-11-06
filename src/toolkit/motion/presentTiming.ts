import { useEffect } from "react";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
import { useSceneContext } from "../../engine/sceneContext";

/** Tells Present and the automatic stills when a hand-built set piece settles: the scene holds after `toMs` (scene-local) and before `outAtMs`, its outro. Drive the piece from `useHeldLocalMs` so it pauses there too. Video export never reads it. */
export function usePresentTiming(toMs: number, outAtMs?: number): void {
  const sceneIndex = useSceneContext()?.index;
  useEffect(() => {
    if (sceneIndex === undefined || !Number.isFinite(toMs)) return;
    return registerPresentTiming(sceneIndex, {
      kind: "group",
      toMs,
      ...(outAtMs !== undefined && Number.isFinite(outAtMs) ? { outAtMs } : {}),
    });
  }, [sceneIndex, toMs, outAtMs]);
}
