import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import type { PerspectiveCamera } from "three";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { useCameraEditStore } from "./cameraEditStore";
import {
  applyCameraPose,
  applyCameraTrack,
  baseCameraPose,
  type CameraKeyframe,
} from "./cameraTrack";
import { useClockStore } from "./clock";
import { renderComposited } from "./compositor";
import { preloadEnvironments } from "./environments";
import { stampCommittedProject } from "./exportBridge";
import { isExporting } from "./exportState";
import { resolveOverlays } from "./overlayPlan";
import {
  buildSceneCameraTracks,
  hasSceneCameraTracks,
  resolveFrameCameras,
  type SceneCameraTrack,
} from "./sceneCamera";
import type { SceneDoc } from "./sceneDocSchema";
import { getSceneHosts } from "./sceneHostRegistry";
import { buildSceneRenderStates, resolveFrameSceneStates } from "./sceneState";
import { resolveAt, type SceneSlot } from "./sceneTimeline";

/** Routes the preview through the same `renderComposited` the exporter calls: a `useFrame` with priority > 0 takes over r3f's automatic render (the documented postprocessing takeover) so every previewed frame goes through the compositor; the clock is read imperatively, `PreviewClock` invalidates on scrub which runs this callback. */
export function CompositorDriver({
  projectId,
  slots,
  cameraTrack,
  sceneDocs,
  theme,
  sceneThemes,
  sceneFrames,
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
  /** Per-scene resolved overlays; drive the cutout render seam. */
  sceneFrames?: (FrameSpec | undefined)[];
  /** The LoadedProject identity, stamped on canvas commit (see exportBridge). */
  commitStamp?: unknown;
}) {
  const invalidate = useThree((s) => s.invalidate);

  // Stamps synchronously with this canvas-tree commit: once the stamp equals a LoadedProject, every scene has committed under that project's themes.
  useLayoutEffect(() => {
    stampCommittedProject(commitStamp ?? null);
  }, [commitStamp]);

  // Normalized once per project load; null entries for scenes without a camera track.
  const sceneTracks = useMemo(() => buildSceneCameraTracks(sceneDocs ?? []), [sceneDocs]);

  // Per-scene render states; null unless the project opts into themed scene state.
  const sceneStates = useMemo(
    () => (theme && sceneThemes ? buildSceneRenderStates(theme, sceneThemes) : null),
    [theme, sceneThemes],
  );

  // Per-scene overlays with panel colours resolved; null unless some scene declares a frame.
  const overlays = useMemo(
    () => (sceneThemes ? resolveOverlays(sceneFrames ?? [], sceneThemes) : null),
    [sceneFrames, sceneThemes],
  );

  // Resolves theme environments for the preview (fire-and-forget; the export preamble awaits its own call); frames rendered before a texture lands take the shared-env fallback, and invalidate repaints with reflections once loaded.
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!theme || !sceneThemes || !sceneStates) return;
    void preloadEnvironments(gl, [theme, ...sceneThemes]).then(() => invalidate());
  }, [gl, theme, sceneThemes, sceneStates, invalidate]);

  // Redraws when the project's timeline changes (e.g. project swap): the scrub position may not move, so PreviewClock wouldn't otherwise invalidate (slots.length keeps the dep real).
  useEffect(() => {
    if (slots.length >= 0) invalidate();
  }, [invalidate, slots]);

  // Redraws on sidecar patches: an edit-bar write re-stages via SceneDocContext with the clock parked; r3f's demand-mode auto-invalidate covers most prop changes, but this pins the repaint for every doc-driven restage regardless of what changed.
  useEffect(() => {
    if (sceneDocs) invalidate();
  }, [invalidate, sceneDocs]);

  // Redraw on camera-edit draft changes (a drag moves the camera without moving the clock).
  useEffect(() => useCameraEditStore.subscribe(() => invalidate()), [invalidate]);

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
    const currentMs = useClockStore.getState().currentMs;
    const resolved = resolveAt(slots, currentMs);
    // Preview-only draft merge: an in-flight camera drag replaces its scene's track for this render, read imperatively (never a subscription into the render) and unreachable during export (`isExporting` above; the export loop samples only `ExportOptions.sceneDocs`).
    let tracks: readonly (SceneCameraTrack | null)[] = sceneTracks;
    const draft = useCameraEditStore.getState().draft;
    if (draft && draft.projectId === projectId && draft.sceneIndex < sceneTracks.length) {
      const merged = sceneTracks.slice();
      merged[draft.sceneIndex] = draft.track;
      tracks = merged;
    }
    // Camera, at this shared seam (mirrored in the export loop), is always a pure function of the clock: projects with scene-doc tracks get a per-frame plan (applied inside renderComposited, per-target on transition frames); projects without fall back to the legacy path, a hard no-op when there's no project-level track either.
    const plan = resolveFrameCameras(tracks, cameraTrack, resolved, currentMs);
    if (!plan) applyCameraTrack(s.camera as PerspectiveCamera, cameraTrack, currentMs);
    // Scene render state, same rules: an opted-in project gets an explicit per-target plan every frame; legacy projects pass undefined and the root scene is never touched.
    const statePlan = resolveFrameSceneStates(sceneStates, resolved);
    renderComposited(
      s.gl,
      s.scene,
      s.camera,
      getSceneHosts(),
      resolved,
      plan ?? undefined,
      statePlan,
      overlays ?? undefined,
    );
  }, 1);

  return null;
}
