/** Dev React (react-dom and r3f's reconciler) records a `performance.measure` with a props diff for every re-render whose props changed, and WebKit keeps them all: every mounted scene re-renders per tick, about 1 MB a frame on a 40-scene project, so a long Verify or a long preview playback passes the 4 GB WebContent ceiling. Production React records none, so this is a no-op there. */
export function dropDevPerformanceEntries(): void {
  if (!import.meta.env.DEV) return;
  performance.clearMeasures();
  performance.clearMarks();
}

let drainInstalled = false;

/** Clears those entries as they land, for whichever window installs it at boot (every entry point does), so preview, Present, the editors and DOM-only re-renders are all covered; the export loop still clears synchronously per frame. */
export function installDevPerformanceDrain(): void {
  if (!import.meta.env.DEV || drainInstalled || typeof PerformanceObserver === "undefined") return;
  drainInstalled = true;
  new PerformanceObserver(dropDevPerformanceEntries).observe({ entryTypes: ["mark", "measure"] });
}
