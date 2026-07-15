/** The project-open settle sequence: everything between "the project loaded" and "the first CORRECT frame is on screen", run behind the loading overlay. Preview/UI lane only; exporter.ts's own preamble is authoritative and never calls in here. Step order is load-bearing (each step traceable to a recorded bug), and the whole sequence races a hard cap so the overlay always reveals, even when an asset is missing (degrades to today's pop-in, never a wedge). */

import { preloadCatalogModels } from "../toolkit/device/catalog";
import { preloadDeviceModels } from "../toolkit/device/models";
import { preloadHeroModels } from "../toolkit/hero/models";
import { preloadBundledBackdrops } from "../toolkit/stage/backdrops";
import { useClockStore } from "./clock";
import { preloadEnvironments } from "./environments";
import { canvasCommittedClockMs, canvasHandle } from "./exportBridge";
import { awaitSceneHostsCommitted } from "./exporter";
import { isExporting } from "./exportState";
import { type LoadedProject, preloadProjectImages } from "./project";
import { awaitProjectCommitted, sceneMiddles } from "./themePreviews";

const SETTLE_CAP_MS = 5000;
const TEXTURE_SETTLE_MS = 200;

/** The overlay's honest progress: one label per completed step. */
export const SETTLE_STEPS = ["Committing scenes", "Loading assets", "Placing the frame"] as const;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (predicate() || Date.now() - t0 > timeoutMs) resolve();
      else setTimeout(tick, 16);
    };
    tick();
  });
}

/** Settle a freshly-opened project to its opening frame. Resolves when the frame is on screen (or the cap expired); `onProgress(completedSteps)` drives the overlay bar. */
export async function settleProjectOpen(
  loaded: LoadedProject,
  onProgress?: (completed: number) => void,
): Promise<void> {
  if (isExporting()) return; // export/autorun own the clock and their own preamble
  const run = (async () => {
    // 1 - the project swap has committed into the canvas tree.
    await awaitProjectCommitted(loaded);
    onProgress?.(1);

    // 2 - the export preamble's asset set, in parallel; each failure degrades alone.
    const guard = (label: string, p: Promise<unknown>) =>
      p.catch((e) => console.warn(`[settle] ${label} preload failed:`, e));
    const gl = canvasHandle.current?.gl;
    await Promise.all([
      guard("device models", preloadDeviceModels()),
      guard("catalog models", preloadCatalogModels()),
      guard("hero models", preloadHeroModels()),
      guard("project images", preloadProjectImages(loaded.id)),
      guard("bundled backdrops", preloadBundledBackdrops()),
      gl
        ? guard("environments", preloadEnvironments(gl, [loaded.theme, ...loaded.sceneThemes]))
        : Promise.resolve(),
    ]);
    await awaitSceneHostsCommitted(loaded.slots.length);
    onProgress?.(2);

    // 3 - the opening frame: first scene's middle, committed, settled, painted.
    const openMs = Math.round(sceneMiddles(loaded)[0] ?? 0);
    if (isExporting()) return; // an export started mid-settle; never touch the clock
    useClockStore.getState().setCurrentMs(openMs);
    await waitFor(() => canvasCommittedClockMs() === openMs, 1000);
    await delay(TEXTURE_SETTLE_MS);
    canvasHandle.current?.advance(performance.now());
    onProgress?.(3);
  })();

  await Promise.race([
    run,
    delay(SETTLE_CAP_MS).then(() =>
      console.warn("[settle] cap expired — revealing with whatever has landed"),
    ),
  ]).catch((e) => console.warn("[settle] failed (revealing anyway):", e));
}
