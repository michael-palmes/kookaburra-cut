import type { PerspectiveCamera } from "three";
import { canvasHandle, localCanvasContextLosses, localCommitStamps } from "../engine/exportBridge";
import {
  awaitSceneHostsCommitted,
  beginExportRun,
  captureFrameRun,
  type ExportRun,
  endExportRun,
  renderExportFrame,
} from "../engine/exportRun";
import { setExporting } from "../engine/exportState";
import { gizmoHandleAt } from "../engine/gizmoRegistry";
import { glContextCensus } from "../engine/glContexts";
import { perfColdWaits } from "../engine/perfProbe";
import type { LoadedProject } from "../engine/project";
import { getSceneHosts } from "../engine/sceneHostRegistry";
import { localSceneModuleProvider } from "../engine/sceneModules";
import { snapshotRun } from "../engine/snapshots";
import type { StageHandle } from "../engine/stageHandle";
import { beginStillsRun, type StillsRun } from "../engine/stillsRun";

/** A stage that runs in the calling realm against `canvasHandle`: the unit tests' stage (they drive the run modules against a scripted canvas), never a window's. */
export function createInlineStage(element?: HTMLCanvasElement): StageHandle {
  let activeExport: ExportRun | null = null;
  let activeStills: StillsRun | null = null;
  let project: LoadedProject | null = null;
  const noop = () => () => {};
  return {
    ready: Promise.resolve(),
    element: element ?? ({} as HTMLCanvasElement),
    stamps: () => ({
      ...localCommitStamps(),
      projectSeq: null,
      primaryHosts: getSceneHosts().filter((h) => h.side === undefined).length,
    }),
    subscribeStamps: noop,
    committedProject: () => (localCommitStamps().project as LoadedProject | null) ?? project,
    frame: () => ({ targets: [], camera: null }),
    subscribeFrame: noop,
    pickers: () => [],
    subscribePickers: noop,
    camera: () => (canvasHandle.current?.camera as PerspectiveCamera | undefined) ?? null,
    compileScenes: (projectId, entries) => localSceneModuleProvider.compile(projectId, entries),
    async loadProject(loaded) {
      project = loaded;
    },
    async applyProject(loaded) {
      project = loaded;
      return 0;
    },
    previewFlags() {},
    awaitHosts: (expected) => awaitSceneHostsCommitted(expected),
    async settle() {},
    async exportBegin(opts, onPrepareStep) {
      activeExport = await beginExportRun(opts, onPrepareStep);
      return { total: activeExport.total };
    },
    async exportFrame(frame, tMs, _poster, buffer, fingerprint) {
      if (!activeExport) throw new Error("no export run is open");
      return renderExportFrame(activeExport, frame, tMs, buffer, fingerprint);
    },
    async exportEnd() {
      const run = activeExport;
      activeExport = null;
      if (run) endExportRun(run);
    },
    async holdExport(on) {
      setExporting(on);
    },
    captureFrame: (opts, tMs) => captureFrameRun(opts, tMs),
    async stillsBegin(opts, settings, onPrepareStep) {
      activeStills = await beginStillsRun(opts, settings, onPrepareStep);
      const { total, pageTimesMs, warnings, pageMeta } = activeStills;
      return { total, pageTimesMs, warnings, pageMeta };
    },
    stillsPage(page) {
      if (!activeStills) throw new Error("no stills run is open");
      return activeStills.render(page);
    },
    async stillsEnd() {
      const run = activeStills;
      activeStills = null;
      run?.end();
    },
    snapshot: (tMs, width, format) => snapshotRun(tMs, width, format),
    async perfRun() {
      throw new Error("the inline stage has no perf probe");
    },
    async perfColdWaits() {
      return perfColdWaits();
    },
    async hitTest(ndcX, ndcY, domain, claim) {
      const hit = gizmoHandleAt(ndcX, ndcY, domain);
      if (hit && claim) hit.claim?.();
      return hit ? { domain: hit.domain, itemId: hit.itemId, sceneIndex: hit.sceneIndex } : null;
    },
    async census() {
      return glContextCensus();
    },
    async forceContextLoss() {
      canvasHandle.current?.gl.forceContextLoss();
    },
    async releasePools() {},
    async invalidateChangedClips() {},
    async evictAllClips() {},
    setCutout() {},
    contextLosses: () => localCanvasContextLosses(),
    subscribeContextLost: noop,
  };
}
