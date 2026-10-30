import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { type PerspectiveCamera, Vector2, type WebGLRenderer } from "three";
import type { LightingSpec, Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { useCameraEditStore } from "./cameraEditStore";
import {
  applyCameraPose,
  applyCameraTrack,
  baseCameraPose,
  type CameraKeyframe,
} from "./cameraTrack";
import { NO_SHUTTER, type ShutterSample, useClockStore } from "./clock";
import { useCompareEditStore } from "./compareEditStore";
import { renderComposited } from "./compositor";
import {
  collectEnvironmentSources,
  collectMirrorRequestsWithCompare,
  preloadEnvironments,
  preloadMirrorEnvironments,
} from "./environments";
import {
  canvasCommittedShutterSeq,
  isCapturingPreview,
  stampCommittedProject,
} from "./exportBridge";
import { isExporting } from "./exportState";
import { FPS, useFormat } from "./format";
import { HELPER_LAYER } from "./lightEditStore";
import { useLightingEditStore } from "./lightingEditStore";
import type { MotionBlurSettings } from "./motionBlur";
import type { ProjectMusic } from "./musicTime";
import { resolveOverlays } from "./overlayPlan";
import {
  previewMotionBlurOff,
  previewMotionBlurPlaybackSamples,
  previewPlaybackActive,
} from "./previewMedia";
import {
  buildSceneCameraTracks,
  type FrameCameraPlan,
  hasSceneCameraTracks,
  resolveFrameCameras,
  type SceneCameraTracks,
  sceneCameraTiming,
} from "./sceneCamera";
import { compareSpecOf, resolveCompareFrame } from "./sceneCompare";
import type { SceneDoc } from "./sceneDocSchema";
import { getSceneHosts } from "./sceneHostRegistry";
import { buildCompareBLightingTracks, buildLightingTracks } from "./sceneLighting";
import { buildRoomTracks } from "./sceneRoom";
import { buildSceneRenderStates, resolveFramePlans } from "./sceneState";
import { resolveAt, type SceneSlot } from "./sceneTimeline";
import {
  accumulateFrame,
  type ShutterAccumulator,
  shutterLaneGeneration,
  startAccumulation,
} from "./shutterLane";
import {
  buildShutterPlan,
  type FrameShutter,
  frameCameraShutter,
  frameObjectShutter,
  frameSampleCount,
  type ShutterPlan,
} from "./shutterPlan";
import { useSceneStageFloors } from "./stageRegistry";

const SETTLE_MS = 150;
const bufferSize = new Vector2();

/** A paused object-blur pass in flight: which frame it serves, its samples, and the running sum. */
interface PreviewProgress {
  ms: number;
  plan: ShutterPlan;
  tracks: readonly (SceneCameraTracks | null)[];
  samples: ShutterSample[];
  cameras: FrameShutter | null;
  order: number[];
  step: number;
  acc: ShutterAccumulator | null;
  done: boolean;
  /** The finished mean has been drawn with every scene back on the frame instant. */
  shown: boolean;
  expectSeq: number;
  generation: number;
  width: number;
  height: number;
}

/** Routes the preview through the same `renderComposited` the exporter calls: a `useFrame` with priority > 0 takes over r3f's automatic render (the documented postprocessing takeover) so every previewed frame goes through the compositor; the clock is read imperatively, `PreviewClock` invalidates on scrub which runs this callback. */
export function CompositorDriver({
  projectId,
  slots,
  cameraTrack,
  sceneDocs,
  theme,
  sceneThemes,
  projectLighting,
  sceneFrames,
  compareBDocs,
  compareBThemes,
  roomThemes,
  motionBlur,
  music,
  commitStamp,
}: {
  /** The loaded project's id, guards the camera-edit draft against a mid-switch mismatch. */
  projectId?: string;
  slots: SceneSlot[];
  cameraTrack?: CameraKeyframe[];
  /** Sidecar docs (index-aligned with slots); the per-scene camera tracks live here. */
  sceneDocs?: (SceneDoc | undefined)[];
  /** The project's theme + resolved per-scene themes; drive the scene-state plan. */
  theme?: Theme;
  sceneThemes?: Theme[];
  /** The manifest's project-default lighting layer (v9); feeds per-scene environment resolution. */
  projectLighting?: LightingSpec;
  /** Per-scene resolved overlays; drive the cutout render seam. */
  sceneFrames?: (FrameSpec | undefined)[];
  /** Comparison side-B docs/themes (`LoadedProject.compareBDocs`/`compareBThemes`); drive the compare plan. */
  compareBDocs?: (SceneDoc | undefined)[];
  compareBThemes?: (Theme | undefined)[];
  /** Themes room keys name (`LoadedProject.roomThemes`). */
  roomThemes?: Readonly<Record<string, Theme>>;
  /** The manifest's `render.motionBlur`; paused frames show the export's blur, playback only on request. */
  motionBlur?: MotionBlurSettings;
  /** The project's authored music (`LoadedProject.music`); resolves musical camera kick positions. */
  music?: ProjectMusic;
  /** The LoadedProject identity, stamped on canvas commit (see exportBridge). */
  commitStamp?: unknown;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const format = useFormat();
  const sceneFloorYs = useSceneStageFloors(slots.length);

  // Stamps synchronously with this canvas-tree commit: once the stamp equals a LoadedProject, every scene has committed under that project's themes.
  useLayoutEffect(() => {
    stampCommittedProject(commitStamp ?? null);
  }, [commitStamp]);

  // Normalized once per project load; null entries for scenes without a camera track.
  const sceneTracks = useMemo(
    () =>
      buildSceneCameraTracks(
        sceneDocs ?? [],
        format,
        sceneFloorYs,
        sceneCameraTiming({ music, slots }),
      ),
    [sceneDocs, format, sceneFloorYs, music, slots],
  );

  const shutterPlan = useMemo(
    () =>
      buildShutterPlan({
        fps: FPS,
        slots,
        sceneDocs,
        sceneThemes,
        motionBlur,
        aspect: format.width / format.height,
      }),
    [slots, sceneDocs, sceneThemes, motionBlur, format],
  );
  // Paused blur draws only on the frame its settle timer fires; any other paused frame renders plain and re-arms it, so scrubs, hovers and edits stay one render each and never show a stale blur.
  const settle = useRef({ timer: 0, fired: false });
  const progress = useRef<PreviewProgress | null>(null);
  useEffect(
    () => () => {
      clearTimeout(settle.current.timer);
      if (useClockStore.getState().shutter !== NO_SHUTTER) {
        useClockStore.getState().setShutter(NO_SHUTTER);
      }
    },
    [],
  );

  // Lighting keyframe tracks (scene-doc layer only); null-for-legacy when nothing keys.
  const lightingTracks = useMemo(
    () => (sceneThemes ? buildLightingTracks(sceneThemes, projectLighting, sceneDocs ?? []) : null),
    [sceneThemes, projectLighting, sceneDocs],
  );
  const compareBLightingTracks = useMemo(
    () =>
      sceneThemes
        ? buildCompareBLightingTracks(sceneThemes, compareBThemes, projectLighting, sceneDocs ?? [])
        : null,
    [sceneThemes, compareBThemes, projectLighting, sceneDocs],
  );

  // Room tracks; null unless some scene has a room.
  const roomTracks = useMemo(
    () =>
      sceneThemes
        ? buildRoomTracks(sceneDocs ?? [], {
            sceneThemes,
            roomThemes,
            projectLighting,
            timing: sceneCameraTiming({ music, slots }),
          })
        : null,
    [sceneDocs, sceneThemes, roomThemes, projectLighting, music, slots],
  );

  // Per-scene render states; null unless the project opts into themed scene state.
  const sceneStates = useMemo(
    () =>
      theme && sceneThemes
        ? buildSceneRenderStates(theme, sceneThemes, { projectId, projectLighting, sceneDocs })
        : null,
    [theme, sceneThemes, projectId, projectLighting, sceneDocs],
  );

  // Per-scene overlays with panel fills resolved; null unless some scene declares a frame.
  const overlays = useMemo(
    () =>
      sceneThemes
        ? resolveOverlays(sceneFrames ?? [], sceneThemes, sceneDocs ?? [], projectId)
        : null,
    [sceneFrames, sceneThemes, sceneDocs, projectId],
  );

  // Comparison plan inputs: normalised specs per scene (chrome colours resolved against each scene's own theme), plus side B's render states built over B-substituted themes/docs (non-compare entries reuse side A's inputs and are never read).
  const compareSpecs = useMemo(
    () => (sceneDocs ?? []).map((d, i) => compareSpecOf(d, sceneThemes?.[i])),
    [sceneDocs, sceneThemes],
  );
  const sceneStatesB = useMemo(() => {
    if (!theme || !sceneThemes || !compareBDocs?.some(Boolean)) return null;
    const bThemes = sceneThemes.map((t, i) => compareBThemes?.[i] ?? t);
    const bDocs = (sceneDocs ?? []).map((d, i) => compareBDocs[i] ?? d);
    return buildSceneRenderStates(theme, bThemes, { projectId, projectLighting, sceneDocs: bDocs });
  }, [theme, sceneThemes, compareBDocs, compareBThemes, sceneDocs, projectId, projectLighting]);

  // Resolves theme environments for the preview (fire-and-forget; the export preamble awaits its own call); frames rendered before a texture lands take the shared-env fallback, and invalidate repaints with reflections once loaded. A missing USER source rejects (it must fail exports loudly); the preview just logs it and renders without reflections.
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!theme || !sceneThemes || !sceneStates) return;
    const sources = collectEnvironmentSources(
      projectId,
      [theme, ...sceneThemes, ...(compareBThemes ?? []).filter((t): t is Theme => !!t)],
      projectLighting,
      [...(sceneDocs ?? []), ...(compareBDocs ?? []).filter(Boolean)],
    );
    void preloadEnvironments(gl, sources)
      .then(() =>
        preloadMirrorEnvironments(
          gl,
          collectMirrorRequestsWithCompare(
            projectId,
            sceneThemes,
            projectLighting,
            sceneDocs,
            compareBThemes,
            compareBDocs,
          ),
        ),
      )
      .then(() => invalidate())
      .catch((e) => console.warn("[environments] preview preload failed:", e));
  }, [
    gl,
    theme,
    sceneThemes,
    sceneStates,
    projectId,
    projectLighting,
    sceneDocs,
    compareBDocs,
    compareBThemes,
    invalidate,
  ]);

  // Redraws when the project's timeline changes (e.g. project swap): the scrub position may not move, so PreviewClock wouldn't otherwise invalidate (slots.length keeps the dep real).
  useEffect(() => {
    if (slots.length >= 0) invalidate();
  }, [invalidate, slots]);

  // Redraws on sidecar patches: an edit-bar write re-stages via SceneDocContext with the clock parked; r3f's demand-mode auto-invalidate covers most prop changes, but this pins the repaint for every doc-driven restage regardless of what changed.
  useEffect(() => {
    if (sceneDocs) invalidate();
  }, [invalidate, sceneDocs]);

  useEffect(() => {
    void sceneTracks;
    invalidate();
  }, [invalidate, sceneTracks]);

  // Redraw on camera-edit draft changes (a drag moves the camera without moving the clock).
  useEffect(() => useCameraEditStore.subscribe(() => invalidate()), [invalidate]);
  // Redraw on divider-lane draft changes, same rule.
  useEffect(() => useCompareEditStore.subscribe(() => invalidate()), [invalidate]);
  useEffect(() => useLightingEditStore.subscribe(() => invalidate()), [invalidate]);

  // Stale-pose healing: the shared camera persists across project switches and a trackless project never writes it, so after previewing a camera-tracked project it would keep the displaced pose; one base-pose write on load is identical floats in the pristine case, so gated projects stay byte-identical (the exporter mirrors this once per run). See docs/determinism.md.
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if ((!cameraTrack || cameraTrack.length === 0) && !hasSceneCameraTracks(sceneTracks)) {
      applyCameraPose(camera as PerspectiveCamera, baseCameraPose());
      invalidate();
    }
  }, [camera, cameraTrack, sceneTracks, invalidate]);

  useFrame((s) => {
    // Stands down while the exporter owns rendering: a stray preview render here would race the export's async text sync and capture stale glyphs (non-deterministic export).
    if (isExporting()) return;
    // Preview frames see the light helpers' layer; the exporter disables it per run (the double guard), and a thumbnail/snapshot capture borrows one frame without it.
    if (isCapturingPreview()) s.camera.layers.disable(HELPER_LAYER);
    else s.camera.layers.enable(HELPER_LAYER);
    const currentMs = useClockStore.getState().currentMs;
    const resolved = resolveAt(slots, currentMs);
    // Preview-only draft merge: an in-flight camera drag replaces its scene's track for this render, read imperatively (never a subscription into the render) and unreachable during export (`isExporting` above; the export loop samples only `ExportOptions.sceneDocs`).
    let tracks: readonly (SceneCameraTracks | null)[] = sceneTracks;
    const draft = useCameraEditStore.getState().draft;
    if (draft && draft.projectId === projectId && draft.sceneIndex < sceneTracks.length) {
      const merged = sceneTracks.slice();
      merged[draft.sceneIndex] = draft.track;
      tracks = merged;
    }
    // Camera, at this shared seam (mirrored in the export loop), is always a pure function of the clock: projects with scene-doc tracks get a per-frame plan (applied inside renderComposited, per-target on transition frames); projects without fall back to the legacy path, a hard no-op when there's no project-level track either.
    const plan = resolveFrameCameras(tracks, cameraTrack, resolved, currentMs);
    if (!plan) applyCameraTrack(s.camera as PerspectiveCamera, cameraTrack, currentMs);
    let frameLightingTracks = lightingTracks;
    let frameCompareBLightingTracks = compareBLightingTracks;
    const lightingDraft = useLightingEditStore.getState().draft;
    if (
      frameLightingTracks &&
      lightingDraft &&
      lightingDraft.projectId === projectId &&
      lightingDraft.sceneIndex < frameLightingTracks.length &&
      sceneThemes?.[lightingDraft.sceneIndex]
    ) {
      const baseDoc = sceneDocs?.[lightingDraft.sceneIndex];
      if (lightingDraft.target === "scene") {
        const merged = frameLightingTracks.slice();
        const draftDoc: SceneDoc = {
          ...(baseDoc ?? { version: 1 }),
          lighting: { ...(baseDoc?.lighting ?? {}), ...lightingDraft.track },
        };
        merged[lightingDraft.sceneIndex] =
          buildLightingTracks([sceneThemes[lightingDraft.sceneIndex]], projectLighting, [
            draftDoc,
          ])[0] ?? null;
        frameLightingTracks = merged;
      } else if (frameCompareBLightingTracks) {
        const mergedTracks = frameCompareBLightingTracks.tracks.slice();
        const mergedOwned = frameCompareBLightingTracks.owned.slice();
        const draftDoc: SceneDoc = {
          ...(baseDoc ?? { version: 1 }),
          compare: {
            ...(baseDoc?.compare ?? {}),
            b: {
              ...(baseDoc?.compare?.b ?? {}),
              lighting: {
                ...(baseDoc?.compare?.b?.lighting ?? {}),
                ...lightingDraft.track,
              },
            },
          },
        };
        const built = buildCompareBLightingTracks(
          [sceneThemes[lightingDraft.sceneIndex]],
          [compareBThemes?.[lightingDraft.sceneIndex]],
          projectLighting,
          [draftDoc],
        );
        mergedTracks[lightingDraft.sceneIndex] = built.tracks[0] ?? null;
        mergedOwned[lightingDraft.sceneIndex] = built.owned[0] ?? false;
        frameCompareBLightingTracks = { tracks: mergedTracks, owned: mergedOwned };
      }
    }
    // Scene render state and lighting, through the resolve export and Present share: an opted-in project gets an explicit per-target plan every frame; legacy projects pass undefined and the root scene is never touched.
    const { statePlan, lightingPlan } = resolveFramePlans(
      {
        sceneStates,
        lightingTracks: frameLightingTracks,
        compareBLightingTracks: frameCompareBLightingTracks,
        roomTracks,
      },
      resolved,
    );
    // The comparison plan, resolved at the same shared seam (mirrored in the export loop); an in-flight divider drag replaces its scene's spec for this render, the camera-draft rule (imperative read, unreachable during export).
    let frameSpecs = compareSpecs;
    const compareDraft = useCompareEditStore.getState().draft;
    if (
      compareDraft &&
      compareDraft.projectId === projectId &&
      compareDraft.sceneIndex < frameSpecs.length
    ) {
      const baseDoc = sceneDocs?.[compareDraft.sceneIndex];
      if (baseDoc?.compare) {
        const merged = frameSpecs.slice();
        merged[compareDraft.sceneIndex] = compareSpecOf(
          { ...baseDoc, compare: { ...baseDoc.compare, track: compareDraft.track } },
          sceneThemes?.[compareDraft.sceneIndex],
        );
        frameSpecs = merged;
      }
    }
    const compareFrame = resolveCompareFrame(frameSpecs, sceneStates, sceneStatesB, resolved);
    const renderWith = (p: FrameCameraPlan | null) =>
      renderComposited(
        s.gl,
        s.scene,
        s.camera,
        getSceneHosts(),
        resolved,
        p ?? undefined,
        statePlan,
        overlays ?? undefined,
        lightingPlan,
        compareFrame,
      );
    s.gl.getDrawingBufferSize(bufferSize);
    const editing = !!(draft || lightingDraft || compareDraft);
    const sampleCamera = (cameras: FrameShutter | null, k: number) => {
      const sample = cameras ? cameras.plans[k] : plan;
      if (!sample) {
        applyCameraTrack(
          s.camera as PerspectiveCamera,
          cameraTrack,
          cameras ? cameras.globalMs[k] : currentMs,
        );
      }
      renderWith(sample);
    };
    const blur = previewBlur(currentMs, editing, tracks);
    if (blur === "plain") {
      renderWith(plan);
      return;
    }
    if (blur === "progress") {
      stepProgress(s.gl, sampleCamera);
      return;
    }
    // Paused frames sample the export's count; playback the toggle's.
    const count =
      blur.samples ?? frameSampleCount(blur.plan, resolved, currentMs, tracks, cameraTrack, plan);
    const cameras = frameCameraShutter(
      blur.plan,
      resolved,
      currentMs,
      tracks,
      cameraTrack,
      plan,
      count,
    );
    const objects =
      blur.samples === undefined ? frameObjectShutter(blur.plan, resolved, tracks, count) : null;
    if (objects) {
      renderWith(plan);
      startProgress(currentMs, blur.plan, tracks, objects, cameras);
      return;
    }
    if (!cameras) {
      renderWith(plan);
      return;
    }
    accumulateFrame(s.gl, bufferSize.x, bufferSize.y, cameras.plans.length, (k) =>
      sampleCamera(cameras, k),
    );
  }, 1);

  /** What this preview frame shows: plain, the next step of a paused object pass, or a camera pass (`samples` undefined means the project's count). Playback blurs the camera only, at the toggle's count; paused frames wait for the playhead to rest and never blur mid-edit. */
  function previewBlur(
    currentMs: number,
    editing: boolean,
    tracks: readonly (SceneCameraTracks | null)[],
  ): "plain" | "progress" | { plan: ShutterPlan; samples: number | undefined } {
    const playing = previewPlaybackActive();
    const eligible = !!shutterPlan && !previewMotionBlurOff() && !isCapturingPreview();
    const p = progress.current;
    if (
      p &&
      (!eligible ||
        playing ||
        editing ||
        p.ms !== currentMs ||
        p.plan !== shutterPlan ||
        p.tracks !== tracks ||
        p.generation !== shutterLaneGeneration() ||
        p.width !== bufferSize.x ||
        p.height !== bufferSize.y)
    ) {
      abortProgress();
    }
    if (!shutterPlan || !eligible) return "plain";
    if (playing) {
      const samples = previewMotionBlurPlaybackSamples();
      return samples > 0 ? { plan: shutterPlan, samples } : "plain";
    }
    const run = progress.current;
    if (run && !run.shown) return "progress";
    // A finished pass is already on screen, so any later frame means something else changed.
    if (run) abortProgress();
    const st = settle.current;
    if (st.fired && !editing) {
      st.fired = false;
      return { plan: shutterPlan, samples: undefined };
    }
    st.fired = false;
    clearTimeout(st.timer);
    if (!editing) {
      st.timer = setTimeout(() => {
        st.fired = true;
        invalidate();
      }, SETTLE_MS) as unknown as number;
    }
    return "plain";
  }

  /** Paused object blur builds up one committed sample per preview frame (each needs a canvas commit), showing the running mean, edges first so a still frame stops at two. */
  function startProgress(
    ms: number,
    plan: ShutterPlan,
    tracks: readonly (SceneCameraTracks | null)[],
    samples: ShutterSample[],
    cameras: FrameShutter | null,
  ) {
    const last = samples.length - 1;
    const order = [0, last, ...samples.slice(1, last).map((_, i) => i + 1)];
    progress.current = {
      ms,
      plan,
      tracks,
      samples,
      cameras,
      order,
      step: 0,
      acc: null,
      done: false,
      shown: false,
      expectSeq: 0,
      generation: shutterLaneGeneration(),
      width: bufferSize.x,
      height: bufferSize.y,
    };
    commitSample(samples[order[0]]);
  }

  function commitSample(sample: ShutterSample) {
    const p = progress.current;
    const clock = useClockStore.getState();
    clock.setShutter(sample);
    if (p) p.expectSeq = useClockStore.getState().shutterSeq;
    invalidate();
  }

  function abortProgress() {
    progress.current = null;
    if (useClockStore.getState().shutter !== NO_SHUTTER) {
      useClockStore.getState().setShutter(NO_SHUTTER);
      invalidate();
    }
  }

  function stepProgress(
    gl: WebGLRenderer,
    sampleCamera: (cameras: FrameShutter | null, k: number) => void,
  ) {
    const p = progress.current;
    if (!p) return;
    const landed = canvasCommittedShutterSeq() === p.expectSeq;
    if (p.done || !landed) {
      // Hold the running mean (or the plain frame already on the canvas) until the sample commits.
      p.acc?.resolve();
      if (p.done && landed) p.shown = true;
      else invalidate();
      return;
    }
    sampleCamera(p.cameras, p.order[p.step]);
    p.acc ??= startAccumulation(gl, p.width, p.height);
    p.acc.add(p.step === 0);
    const finished =
      p.step === p.order.length - 1 || (p.step === 1 && !p.cameras && p.acc.lastMatchesKept());
    p.acc.resolve();
    if (finished) {
      p.done = true;
      commitSample(NO_SHUTTER);
      return;
    }
    p.step++;
    commitSample(p.samples[p.order[p.step]]);
  }

  return null;
}
