/** Where an export's wall time went: milliseconds per phase, summed over the run. Read only, never an input to a frame. */
export interface ExportTiming {
  frames: number;
  ms: Record<string, number>;
}

export function newExportTiming(): ExportTiming {
  return { frames: 0, ms: {} };
}

/** Adds the time since `sinceMs` to `phase` and returns now, so phases chain. */
export function addPhase(timing: ExportTiming | undefined, phase: string, sinceMs: number): number {
  const now = performance.now();
  if (timing) timing.ms[phase] = (timing.ms[phase] ?? 0) + (now - sinceMs);
  return now;
}

/** The window's phases beside the stage's: `handoff` is what a frame's round trip took beyond the stage's own work. */
export function mergeExportTiming(
  window: ExportTiming,
  stage: ExportTiming | null | undefined,
): ExportTiming {
  const ms: Record<string, number> = { ...window.ms };
  let staged = 0;
  for (const [phase, value] of Object.entries(stage?.ms ?? {})) {
    ms[phase] = value;
    if (phase !== "prepare") staged += value;
  }
  if (stage && ms.stage !== undefined) ms.handoff = Math.max(0, ms.stage - staged);
  delete ms.stage;
  for (const phase of Object.keys(ms)) ms[phase] = Math.round(ms[phase]);
  return { frames: window.frames, ms };
}
