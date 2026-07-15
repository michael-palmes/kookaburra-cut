import { VSMShadowMap } from "three";
import { useEditorStore } from "../store/editorStore";
import type { FormatInfo } from "../toolkit/types";

export type AspectName = "16:9" | "9:16" | "1:1" | "4:5";

/** Canonical export/preview frame rate: export steps the clock at `tMs = frame * 1000 / FPS` and embedded `VideoClip`s pre-extract to a matching CFR sequence, so one frame index maps 1:1 to one source frame. Changing it re-baselines determinism, re-run Verify ×2. */
export const FPS = 60;

/** MSAA sample count requested on every render path (context, compositor A/B targets, effects composer input buffer) so geometry edges resolve identically whichever path a frame takes; three/postprocessing clamp to `capabilities.maxSamples`. CHANGING THIS IS A FULL BASELINE REBASE. */
export const MSAA_SAMPLES = 4;

/** Renderer shadow-map type: VSM drives a REAL (deterministic) gaussian blur via `shadow.radius`, giving the soft photoshoot falloff the staged themes want; PCFSoft ignores radius entirely. Enabled globally but inert for any project without a staged (castShadow) light. Staged-scene shadow params (mapSize, radius, bias, the ortho frustum in SceneStage) are export contract; CHANGING THIS TYPE REBASES EVERY STAGED PROJECT. */
export const SHADOW_MAP_TYPE = VSMShadowMap;

export interface FormatSpec {
  name: AspectName;
  width: number;
  height: number;
}

/** Every aspect this app can export; scenes read `useFormat()` so they stay responsive without per-format files. */
export const FORMATS: Record<AspectName, FormatSpec> = {
  "16:9": { name: "16:9", width: 3840, height: 2160 },
  "9:16": { name: "9:16", width: 2160, height: 3840 },
  "1:1": { name: "1:1", width: 2160, height: 2160 },
  // Portrait social format, first-class (2026 marketing set).
  "4:5": { name: "4:5", width: 2160, height: 2700 },
};

/** The standing determinism matrix: Verify's "all" and phase-close gates stay these three; 4:5 baselines are feature-scoped (launch + tour anchors). */
export const STANDING_ASPECTS: AspectName[] = ["16:9", "9:16", "1:1"];

/** Safe-area inset as a fraction of the smaller (world) dimension. */
const SAFE_INSET = 0.06;

/** Shared camera config: read by both the preview `<Canvas camera>` and the world-space safe-area math, so the layout scenes see matches what's rendered. The perspective FOV is vertical, so the visible world HEIGHT is constant across aspects (only width changes). */
export const CAMERA = {
  position: [0, 0, 5] as [number, number, number],
  fov: 45,
  /** Z of the plane scenes lay out on. */
  contentZ: 0,
};

/** Visible world rectangle at the content plane for a given aspect. */
function visibleWorldSize(aspect: number): { width: number; height: number } {
  const distance = CAMERA.position[2] - CAMERA.contentZ;
  const height = 2 * Math.tan((CAMERA.fov * Math.PI) / 360) * distance;
  return { width: height * aspect, height };
}

export function computeFormat(spec: FormatSpec): FormatInfo {
  const aspect = spec.width / spec.height;
  const frame = visibleWorldSize(aspect);
  const inset = SAFE_INSET * Math.min(frame.width, frame.height);
  return {
    width: spec.width,
    height: spec.height,
    aspect,
    frame,
    safe: { top: inset, right: inset, bottom: inset, left: inset },
  };
}

/** Reactive format info for the currently selected export aspect. */
export function useFormat(): FormatInfo {
  const spec = useEditorStore((s) => s.format);
  return computeFormat(spec);
}
