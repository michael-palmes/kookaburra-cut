import { flushSync } from "react-dom";
import type { Camera, Object3D, PerspectiveCamera, Scene, Vector2, WebGLRenderer } from "three";
import { awaitEmojiRastersIdle } from "../toolkit/text/emojiRaster";
import { applyCameraTrack, type CameraKeyframe } from "./cameraTrack";
import { awaitVideoFramesReady } from "./clips";
import { useClockStore } from "./clock";
import { renderComposited } from "./compositor";
import { canvasCommittedClockMs, canvasCommittedHoldsVersion } from "./exportBridge";
import type { ExportOptions } from "./exporter";
import { computeFormat } from "./format";
import { yieldMacrotask } from "./macrotask";
import { resolveOverlays } from "./overlayPlan";
import { type ReadbackContext, readFrameOrThrow } from "./readback";
import { buildSceneCameraTracks, resolveFrameCameras } from "./sceneCamera";
import { compareSpecOf, resolveCompareFrame } from "./sceneCompare";
import { getSceneHosts } from "./sceneHostRegistry";
import {
  buildCompareBLightingTracks,
  buildLightingTracks,
  resolveFrameLighting,
} from "./sceneLighting";
import { buildSceneRenderStates, resolveFrameSceneStates } from "./sceneState";
import type { Resolved } from "./sceneTimeline";
import type { snapshotSceneStageFloors } from "./stageRegistry";

/** The per-frame body the deterministic loops share (video export and stills): barriers, camera/state/lighting/compare plans, `renderComposited`, readback. Moved verbatim out of exporter.ts, so the video loop's GL call sequence is unchanged. See docs/determinism.md. */

/** Waits until the canvas tree has committed `tMs`. The canvas subtree renders in the r3f reconciler, which react-dom's `flushSync` does not flush, so its commit usually lands within a macrotask or two; per-mesh readiness hooks are only trustworthy for this frame after that commit, since awaiting them earlier can capture the previous frame's texture/glyphs (the back-to-back Verify ×2 race). Deterministic by construction: the loop's duration varies, its outcome never does. */
export async function awaitCanvasClockCommit(tMs: number): Promise<void> {
  for (let spins = 0; canvasCommittedClockMs() !== tMs; spins++) {
    if (spins > 5000) {
      throw new Error(
        `Canvas tree never committed clock ${tMs}ms (stuck at ${canvasCommittedClockMs()}ms).`,
      );
    }
    await yieldMacrotask();
  }
}

/** Waits until the canvas tree has committed scene-hold `version` (`replaceSceneHolds`); the clock barrier cannot see a hold change when the playhead already sits on the first still. */
export async function awaitHoldsCommitted(version: number): Promise<void> {
  for (let spins = 0; canvasCommittedHoldsVersion() !== version; spins++) {
    if (spins > 5000) {
      throw new Error(
        `Canvas tree never committed scene holds v${version} (stuck at v${canvasCommittedHoldsVersion()}).`,
      );
    }
    await yieldMacrotask();
  }
}

/** The subset of troika-three-text's Text we drive. `_needsSync`/`_isSyncing` are private but stable in the pinned 0.52.4, and are the only way to detect quiescence, since troika's `sync(cb)` silently drops the callback when `_needsSync` is false (including while a typeset is in flight). */
interface TroikaTextLike {
  sync: (cb?: () => void) => void;
  _needsSync?: boolean;
  _isSyncing?: boolean;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
}

/** Awaits typesetting for every troika text mesh in the scene: per-frame layout can be async (e.g. a counter whose text changes each frame), so we must wait for it before capturing or read stale glyphs. Two hard-won subtleties (the text half of the back-to-back Verify ×2 race): troika meshes are detected via `material.isTroikaTextMaterial`, since the mesh itself carries no `isTroikaText` flag in troika 0.52.4; and a pending typeset is kicked here (pre-render) rather than left to troika's own `onBeforeRender` kick (which would start it a frame late), with quiescence awaited via the `synccomplete` event since `sync(cb)` drops callbacks when no new sync is needed. Exported for the borrowed-clock capture paths (snapshots.ts), whose single forced paint otherwise reads glyphs one capture late (the invisible-Playfair-title theme-preview bug). */
export function awaitTextSync(scene: Scene): Promise<void> {
  const pending: Promise<void>[] = [];
  scene.traverse((obj: Object3D) => {
    const material = (obj as { material?: { isTroikaTextMaterial?: boolean } }).material;
    const mesh = obj as unknown as TroikaTextLike;
    if (!material?.isTroikaTextMaterial || typeof mesh.sync !== "function") return;
    pending.push(
      new Promise<void>((resolve) => {
        const settle = () => {
          // Kicks a queued typeset now so this frame's text lays out before the render (troika would otherwise only kick it during onBeforeRender, one frame late).
          if (mesh._needsSync) mesh.sync();
          if (!mesh._needsSync && !mesh._isSyncing) {
            mesh.removeEventListener("synccomplete", settle);
            resolve();
          }
        };
        mesh.addEventListener("synccomplete", settle);
        settle();
      }),
    );
  });
  return Promise.all(pending).then(() => undefined);
}

/** Dev React (react-dom and r3f's reconciler) records a `performance.measure` with a props diff for every re-render whose props changed, and WebKit keeps them all: every mounted scene re-renders per tick, about 1 MB a frame on a 40-scene project, enough to reach the 4 GB WebContent ceiling mid-Verify. Production React records none. */
export function dropDevPerformanceEntries(): void {
  if (!import.meta.env.DEV) return;
  performance.clearMeasures();
  performance.clearMarks();
}

/** Everything a run resolves once and every frame samples. */
export interface FramePlans {
  sceneTracks: ReturnType<typeof buildSceneCameraTracks>;
  lightingTracks: ReturnType<typeof buildLightingTracks> | null;
  compareBLightingTracks: ReturnType<typeof buildCompareBLightingTracks> | null;
  sceneStates: ReturnType<typeof buildSceneRenderStates>;
  compareSpecs: ReturnType<typeof compareSpecOf>[];
  sceneStatesB: ReturnType<typeof buildSceneRenderStates>;
  overlays: ReturnType<typeof resolveOverlays>;
}

export function buildFramePlans(
  opts: ExportOptions,
  sceneFloorYs: ReturnType<typeof snapshotSceneStageFloors>,
): FramePlans {
  // Per-scene camera tracks, normalized once for the whole run; projects without any stay on the legacy camera path below, byte-identically.
  const sceneTracks = buildSceneCameraTracks(
    opts.sceneDocs ?? [],
    computeFormat(opts.format),
    sceneFloorYs,
  );
  const lightingTracks = opts.sceneThemes
    ? buildLightingTracks(opts.sceneThemes, opts.projectLighting, opts.sceneDocs ?? [])
    : null;
  const compareBLightingTracks = opts.sceneThemes
    ? buildCompareBLightingTracks(
        opts.sceneThemes,
        opts.compareBThemes,
        opts.projectLighting,
        opts.sceneDocs ?? [],
      )
    : null;

  // Per-scene render states, built once; null unless the project opts into themed scene state (mirrored in CompositorDriver).
  const sceneStates =
    opts.theme && opts.sceneThemes
      ? buildSceneRenderStates(opts.theme, opts.sceneThemes, {
          projectId: opts.projectId,
          projectLighting: opts.projectLighting,
          sceneDocs: opts.sceneDocs,
        })
      : null;

  // Comparison plan inputs, built once (mirrored in CompositorDriver): specs per scene, plus side B's states over B-substituted themes/docs.
  const compareSpecs = (opts.sceneDocs ?? []).map((d, i) =>
    compareSpecOf(d, opts.sceneThemes?.[i]),
  );
  const sceneStatesB =
    opts.theme && opts.sceneThemes && opts.compareBDocs?.some(Boolean)
      ? buildSceneRenderStates(
          opts.theme,
          opts.sceneThemes.map((t, i) => opts.compareBThemes?.[i] ?? t),
          {
            projectId: opts.projectId,
            projectLighting: opts.projectLighting,
            sceneDocs: (opts.sceneDocs ?? []).map((d, i) => opts.compareBDocs?.[i] ?? d),
          },
        )
      : null;

  // Per-scene overlays, resolved once; null unless some scene declares a frame (mirrored in CompositorDriver).
  const overlays = opts.sceneThemes
    ? resolveOverlays(
        opts.sceneFrames ?? [],
        opts.sceneThemes,
        opts.sceneDocs ?? [],
        opts.projectId,
      )
    : null;

  return {
    sceneTracks,
    lightingTracks,
    compareBLightingTracks,
    sceneStates,
    compareSpecs,
    sceneStatesB,
    overlays,
  };
}

/** The live canvas plus the run's fixed buffers and plans; `clockOwnedMs` records the last clock value the run wrote, for the finally's playhead hand-back. */
export interface FrameRig {
  gl: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  ctx: ReadbackContext;
  width: number;
  height: number;
  /** The one reused readback buffer (GL bottom-up rows). */
  rgba: Uint8Array;
  sizeProbe: Vector2;
  plans: FramePlans;
  cameraTrack?: CameraKeyframe[];
  clockOwnedMs: number | null;
}

/** One frame of the deterministic loop into `rig.rgba`: seek, barriers, size guard, plans, `draws` renders (the last one kept), then the guarded readback. `beforeRead` runs between the last draw and the readback. */
export async function renderFrameInto(
  rig: FrameRig,
  tMs: number,
  resolved: Resolved,
  draws: number,
  label: string,
  beforeRead?: () => void,
): Promise<void> {
  const { gl, scene, camera, width, height, sizeProbe, plans } = rig;
  const cam = camera as PerspectiveCamera;
  dropDevPerformanceEntries();
  // flushSync commits the DOM tree; the canvas tree (r3f reconciler) commits on its own schedule, so wait for it before trusting any per-mesh readiness hook for this frame.
  flushSync(() => useClockStore.getState().setCurrentMs(tMs));
  rig.clockOwnedMs = tMs;
  await awaitCanvasClockCommit(tMs);
  // Ensure each VideoClip's current frame texture is uploaded first (this may yield)...
  await awaitVideoFramesReady(scene);
  // ...then syncs troika text last, immediately before the render, with no async gap after it where a stray render or worker message could leave a text mesh stale at capture.
  await awaitTextSync(scene);
  // Emoji rasters requested this frame (e.g. a counter format emitting an unseen cluster) settle before capture, so a texture can never pop in at a run-dependent frame.
  await awaitEmojiRastersIdle();
  // Guards against mid-run interference (e.g. a window resize retriggering r3f's size handling, which would corrupt every remaining captured frame); re-asserts the export size only if drifted, since an unconditional setSize would clear the canvas every frame. Resize events land during the awaits above; from here to readPixels is synchronous, so a corrected size cannot drift again before capture.
  gl.getSize(sizeProbe);
  if (sizeProbe.x !== width || sizeProbe.y !== height || gl.getPixelRatio() !== 1) {
    gl.setPixelRatio(1);
    gl.setSize(width, height, false);
  }
  if (cam.isPerspectiveCamera && cam.aspect !== width / height) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }
  // The camera applies at this shared seam (mirrored in CompositorDriver), a pure function of tMs. Scene-doc tracks get a per-frame plan applied inside renderComposited (per-target on transition frames); otherwise the legacy project-track path runs, a hard no-op when the project declares no track. Neither touches `cam.aspect`, so the resize guard above stays the sole owner of aspect.
  const plan = resolveFrameCameras(plans.sceneTracks, rig.cameraTrack, resolved, tMs);
  if (!plan) applyCameraTrack(cam, rig.cameraTrack, tMs);
  const statePlan = resolveFrameSceneStates(plans.sceneStates, resolved);
  const lightingPlan = resolveFrameLighting(
    plans.lightingTracks,
    resolved,
    plans.compareBLightingTracks,
  );
  const compareFrame = resolveCompareFrame(
    plans.compareSpecs,
    plans.sceneStates,
    plans.sceneStatesB,
    resolved,
  );
  // Same render path as the preview (engine/compositor): single-scene frames render directly (v0-identical), transition frames go through the composite. The first frame draws twice and keeps the second, so it is never the run's first draw: a cold boot (hidden window, no preview frames) must capture what a warm one does.
  for (let draw = draws; draw > 0; draw--) {
    renderComposited(
      gl,
      scene,
      camera,
      getSceneHosts(),
      resolved,
      plan ?? undefined,
      statePlan,
      plans.overlays ?? undefined,
      lightingPlan ?? undefined,
      compareFrame,
    );
  }
  beforeRead?.();
  readFrameOrThrow(rig.ctx, width, height, rig.rgba, label);
}
