import type { Resolved, SceneSlot } from "./sceneTimeline";

export function normalExportFrameCount(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

export interface PosterFrameSample {
  tMs: number;
  resolved: Resolved;
}

export function posterFrameSample(slots: SceneSlot[], fps: number): PosterFrameSample {
  const first = slots[0];
  if (!first) throw new Error("A poster frame needs a first scene.");
  const firstSceneFrames = normalExportFrameCount(first.durationMs, fps);
  const lowerCentreFrame = Math.floor((firstSceneFrames - 1) / 2);
  const localMs = lowerCentreFrame * (1000 / fps);
  return {
    tMs: first.startMs + localMs,
    resolved: { active: [{ index: first.index, localMs }] },
  };
}

export function exportFrameTimeMs(frame: number, fps: number, posterMs?: number): number {
  if (posterMs === undefined) return frame * (1000 / fps);
  return frame === 0 ? posterMs : (frame - 1) * (1000 / fps);
}
