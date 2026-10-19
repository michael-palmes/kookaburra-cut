import { flushSync } from "react-dom";
import type { Camera, Object3D, PerspectiveCamera, Scene, Vector2, WebGLRenderer } from "three";
import { Text as TroikaText } from "troika-three-text";
import { awaitEmojiRastersIdle } from "../toolkit/text/emojiRaster";
import { applyCameraTrack, type CameraKeyframe } from "./cameraTrack";
import { awaitVideoFramesReady } from "./clips";
import { NO_SHUTTER, type ShutterSample, useClockStore } from "./clock";
import { renderComposited } from "./compositor";
import { dropDevPerformanceEntries } from "./devPerformance";
import {
  canvasCommittedClockMs,
  canvasCommittedHoldsVersion,
  canvasCommittedShutterSeq,
} from "./exportBridge";
import type { ExportOptions } from "./exporter";
import { isExporting } from "./exportState";
import { computeFormat } from "./format";
import { yieldMacrotask } from "./macrotask";
import { resolveOverlays } from "./overlayPlan";
import { type ReadbackContext, readFrameOrThrow } from "./readback";
import {
  buildSceneCameraTracks,
  type FrameCameraPlan,
  resolveFrameCameras,
  sceneCameraTiming,
} from "./sceneCamera";
import { compareSpecOf, resolveCompareFrame } from "./sceneCompare";
import { getSceneHosts } from "./sceneHostRegistry";
import { buildCompareBLightingTracks, buildLightingTracks } from "./sceneLighting";
import { buildRoomTracks } from "./sceneRoom";
import { buildSceneRenderStates, resolveFramePlans } from "./sceneState";
import type { Resolved } from "./sceneTimeline";
import { accumulateFrame, releaseShutterLane, startAccumulation } from "./shutterLane";
import {
  buildShutterPlan,
  frameCameraShutter,
  frameObjectShutter,
  frameSampleCount,
  type ShutterPlan,
} from "./shutterPlan";
import type { snapshotSceneStageFloors } from "./stageRegistry";
import { textDerivedPendingCount } from "./textDerivedState";

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

/** Awaits typesetting for every troika text mesh in the scene: per-frame layout can be async (e.g. a counter whose text changes each frame), so we must wait for it before capturing or read stale glyphs. Hard-won subtleties (the text half of the back-to-back Verify ×2 race): meshes are matched by class, since troika's mesh carries no `isTroikaText` flag and its `material` getter returns `[outline, main]` for outlined text (neon, whole-block blur-in), so material sniffing misses them; a pending typeset is kicked here (pre-render) rather than left to troika's own `onBeforeRender` kick (which would start it a frame late), with quiescence awaited via the `synccomplete` event since `sync(cb)` drops callbacks when no new sync is needed; and the wait is spin-bounded, failing the run rather than hanging on a typeset that never lands. Exported for the borrowed-clock capture paths (snapshots.ts), whose single forced paint otherwise reads glyphs one capture late (the invisible-Playfair-title theme-preview bug). */
export async function awaitTextSync(scene: Scene): Promise<void> {
  await settleTypesets(scene);
  if (textDerivedPendingCount() === 0) return;
  // Layout derived from measured text re-renders after its typesets land; settle until none is outstanding, then once more for typesets the settling commit queued.
  for (let spins = 0; textDerivedPendingCount() > 0; spins++) {
    if (spins > 5000) {
      throw new Error(`Text-derived layout never settled: ${textDerivedPendingCount()} pending.`);
    }
    await yieldMacrotask();
    await settleTypesets(scene);
  }
  await settleTypesets(scene);
}

async function settleTypesets(scene: Scene): Promise<void> {
  const unsettled = new Set<TroikaText>();
  const pending: Promise<void>[] = [];
  scene.traverse((obj: Object3D) => {
    if (!(obj instanceof TroikaText)) return;
    const mesh = obj;
    unsettled.add(mesh);
    pending.push(
      new Promise<void>((resolve) => {
        const settle = () => {
          // Kicks a queued typeset now so this frame's text lays out before the render (troika would otherwise only kick it during onBeforeRender, one frame late).
          if (mesh._needsSync) mesh.sync();
          if (!mesh._needsSync && !mesh._isSyncing) {
            mesh.removeEventListener("synccomplete", settle);
            unsettled.delete(mesh);
            resolve();
          }
        };
        mesh.addEventListener("synccomplete", settle);
        settle();
      }),
    );
  });
  if (unsettled.size === 0) return;
  const stalled = async (): Promise<void> => {
    for (let spins = 0; unsettled.size > 0; spins++) {
      if (spins > 5000) {
        const texts = [...unsettled].map((mesh) => JSON.stringify(mesh.text)).join(", ");
        throw new Error(`Text typesetting never settled: ${unsettled.size} pending (${texts}).`);
      }
      await yieldMacrotask();
    }
  };
  await Promise.race([Promise.all(pending), stalled()]);
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
  /** Null unless some scene has a room. */
  roomTracks: ReturnType<typeof buildRoomTracks>;
  /** Null unless some scene's motion blur is on, which keeps the run on the byte-identical path. */
  shutter: ShutterPlan | null;
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
    sceneCameraTiming(opts),
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

  const roomTracks = opts.sceneThemes
    ? buildRoomTracks(opts.sceneDocs ?? [], {
        sceneThemes: opts.sceneThemes,
        roomThemes: opts.roomThemes,
        projectLighting: opts.projectLighting,
        timing: sceneCameraTiming(opts),
      })
    : null;

  const shutter = buildShutterPlan({
    fps: opts.fps,
    slots: opts.slots,
    sceneDocs: opts.sceneDocs,
    sceneThemes: opts.sceneThemes,
    motionBlur: opts.motionBlur,
    aspect: opts.format.width / opts.format.height,
  });

  return {
    sceneTracks,
    lightingTracks,
    compareBLightingTracks,
    sceneStates,
    compareSpecs,
    sceneStatesB,
    overlays,
    roomTracks,
    shutter,
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
  await clearShutterSample(scene);
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
  await drawPlannedFrame(
    gl,
    scene,
    camera,
    width,
    height,
    plans,
    rig.cameraTrack,
    resolved,
    tMs,
    draws,
  );
  beforeRead?.();
  readFrameOrThrow(rig.ctx, width, height, rig.rgba, label);
}

/** Resolves one frame's camera, state, lighting and compare plans and draws it into the canvas `draws` times, the last one kept (the export loop's frame 0 draws twice so it is never a run's first draw: a cold boot must capture what a warm one does). Each draw is one plain render, or, while the camera moves across an open shutter, the averaged samples of the motion blur lane. Shared by the export loop and single-frame captures. */
export async function drawPlannedFrame(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  width: number,
  height: number,
  plans: FramePlans,
  cameraTrack: CameraKeyframe[] | undefined,
  resolved: Resolved,
  tMs: number,
  draws: number,
): Promise<void> {
  const cam = camera as PerspectiveCamera;
  // The camera applies at this shared seam (mirrored in CompositorDriver), a pure function of tMs. Scene-doc tracks get a per-frame plan applied inside renderComposited (per-target on transition frames); otherwise the legacy project-track path runs, a hard no-op when the project declares no track. Neither touches `cam.aspect`, so the caller's resize guard stays the sole owner of aspect.
  const plan = resolveFrameCameras(plans.sceneTracks, cameraTrack, resolved, tMs);
  if (!plan) applyCameraTrack(cam, cameraTrack, tMs);
  const { statePlan, lightingPlan } = resolveFramePlans(plans, resolved);
  const compareFrame = resolveCompareFrame(
    plans.compareSpecs,
    plans.sceneStates,
    plans.sceneStatesB,
    resolved,
  );
  // Same render path as the preview (engine/compositor): single-scene frames render directly (v0-identical), transition frames go through the composite.
  const renderWith = (p: FrameCameraPlan | null) =>
    renderComposited(
      gl,
      scene,
      camera,
      getSceneHosts(),
      resolved,
      p ?? undefined,
      statePlan,
      plans.overlays ?? undefined,
      lightingPlan,
      compareFrame,
    );
  const count = plans.shutter
    ? frameSampleCount(plans.shutter, resolved, tMs, plans.sceneTracks, cameraTrack, plan)
    : undefined;
  const cameras = plans.shutter
    ? frameCameraShutter(plans.shutter, resolved, tMs, plans.sceneTracks, cameraTrack, plan, count)
    : null;
  const objects = plans.shutter
    ? frameObjectShutter(plans.shutter, resolved, plans.sceneTracks, count)
    : null;
  if (!cameras && !objects && isExporting()) releaseShutterLane();
  const renderSample = (k: number) => {
    const sample = cameras ? cameras.plans[k] : plan;
    if (!sample) applyCameraTrack(cam, cameraTrack, cameras ? cameras.globalMs[k] : tMs);
    renderWith(sample);
  };
  for (let draw = draws; draw > 0; draw--) {
    if (objects)
      await drawObjectSamples(gl, scene, width, height, objects, !!cameras, renderSample);
    else if (cameras) accumulateFrame(gl, width, height, cameras.plans.length, renderSample);
    else renderWith(plan);
  }
}

/** Puts every scene back on the frame instant when a preview sample was left committed (a run can start mid paused blur); a no-op otherwise, so unblurred runs never touch the shutter. */
export async function clearShutterSample(scene: Scene): Promise<void> {
  if (useClockStore.getState().shutter !== NO_SHUTTER) await commitShutterSample(scene, NO_SHUTTER);
}

/** Commits one shutter sample's object times and waits until the canvas tree has rendered them. */
async function commitShutterSample(scene: Scene, sample: ShutterSample): Promise<void> {
  dropDevPerformanceEntries();
  flushSync(() => useClockStore.getState().setShutter(sample));
  const seq = useClockStore.getState().shutterSeq;
  for (let spins = 0; canvasCommittedShutterSeq() !== seq; spins++) {
    if (spins > 5000) throw new Error(`Canvas tree never committed shutter sample ${seq}.`);
    await yieldMacrotask();
  }
  await awaitTextSync(scene);
}

/** The object lane: the shutter's two edge samples first, and the rest only when the camera moves or the edges differ, so a still frame costs two samples and averages back to its exact bytes. The clock always ends back on the frame instant. */
async function drawObjectSamples(
  gl: WebGLRenderer,
  scene: Scene,
  width: number,
  height: number,
  samples: ShutterSample[],
  cameraMoves: boolean,
  renderSample: (k: number) => void,
): Promise<void> {
  const last = samples.length - 1;
  const acc = startAccumulation(gl, width, height);
  try {
    await commitShutterSample(scene, samples[0]);
    renderSample(0);
    acc.add(true);
    await commitShutterSample(scene, samples[last]);
    renderSample(last);
    acc.add();
    if (cameraMoves || !acc.lastMatchesKept()) {
      for (let k = 1; k < last; k++) {
        await commitShutterSample(scene, samples[k]);
        renderSample(k);
        acc.add();
      }
    }
  } catch (error) {
    // The run is failing: put the clock back without waiting on a canvas that may have stopped committing, so the original error surfaces.
    flushSync(() => useClockStore.getState().setShutter(NO_SHUTTER));
    throw error;
  }
  await commitShutterSample(scene, NO_SHUTTER);
  acc.resolve();
}
