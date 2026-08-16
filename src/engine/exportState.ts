/** Whether a deterministic export is in progress; guards the exporter's frame-by-frame render (seek, await troika's async text sync, render + read pixels) against the preview driver's `invalidate()`-triggered renders racing that sync and capturing stale glyphs. Depth-counted so `verifyDeterminism` can hold it across its whole run, nested over each pass's own hold, so no preview frame perturbs GPU state between pass A and pass B. See engine/exporter.ts, docs/determinism.md. */
let holds = 0;
const listeners = new Set<() => void>();

export function setExporting(value: boolean): void {
  const wasExporting = holds > 0;
  holds = Math.max(0, holds + (value ? 1 : -1));
  const exporting = holds > 0;
  if (wasExporting !== exporting) {
    for (const listener of listeners) listener();
  }
}

export function isExporting(): boolean {
  return holds > 0;
}

export function subscribeExporting(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function withExporting<T>(run: () => Promise<T>): Promise<T> {
  setExporting(true);
  try {
    return await run();
  } finally {
    setExporting(false);
  }
}
