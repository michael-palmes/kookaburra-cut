/** Stills page plan: `planStillPages(input)` turns the slots, scene docs, a Present timing snapshot per scene and the exporter's built tracks into the ordered pages, the automatic stills' holds and typed warnings; `autoStillLocalMs` is one scene's settled moment. Pure: no React, no clock reads, no registries (timings arrive through `timingsFor`). */

import { chartAnimationEndMs } from "../toolkit/chart/animation";
import type { CameraKeyframe } from "./cameraTrack";
import { exportFrameTimeMs } from "./exportFrames";
import { derivePresentHold } from "./presentHoldPoint";
import type { PresentTimingEntry } from "./presentTimingRegistry";
import { buildSceneCameraTracks, type SceneCameraTracks, sceneCameraEndMs } from "./sceneCamera";
import { resolveChart } from "./sceneChart";
import type { SceneDoc } from "./sceneDocSchema";
import type { LightingTrack } from "./sceneLighting";
import { resolveSceneDocMedia, sceneMediaMotionEndMs } from "./sceneMedia";
import { type Resolved, resolveAt, type SceneSlot } from "./sceneTimeline";
import { sceneTitle } from "./sceneTitle";
import {
  STILLS_FPS,
  type StillSource,
  sceneStillsPlan,
  snapStillFrame,
  soloFrameRange,
  soloWindow,
  soloWindowIsEmpty,
} from "./stills";

export interface AutoStillInputs {
  slots: readonly SceneSlot[];
  index: number;
  doc: SceneDoc | undefined;
  /** The scene's Present timing snapshot (`snapshotPresentTimings`). */
  timings: readonly PresentTimingEntry[];
  /** This scene's `buildSceneCameraTracks` entry; null hands the camera to the project track. */
  sceneTrack?: SceneCameraTracks | null;
  /** This scene's built lighting track (`buildLightingTracks`, which already honours `animationEnabled`). */
  lightingTrack?: LightingTrack | null;
  /** This scene's built comparison B lighting track. */
  compareBLightingTrack?: LightingTrack | null;
  /** The manifest's project camera track, global ms. */
  projectCameraTrack?: readonly CameraKeyframe[] | null;
}

export interface AutoStill {
  /** Scene-local ms the still lands at, before the solo-window clamp and frame snap. */
  settledMs: number;
  /** Present's hold: held text, groups and decorations freeze here while raw time runs on. */
  holdMs: number;
  /** `centre` when nothing registered or keyed, so the still sits mid solo window. */
  basis: "settled" | "centre";
}

export interface StillPagesInput {
  slots: readonly SceneSlot[];
  sceneDocs: readonly (SceneDoc | undefined)[];
  /** Present timing snapshot per scene, read once the registry has settled (no pending reports). */
  timingsFor: (sceneIndex: number) => readonly PresentTimingEntry[];
  fps?: number;
  /** `buildSceneCameraTracks(...)`; built from the docs when undefined, null means none. */
  sceneTracks?: readonly (SceneCameraTracks | null)[] | null;
  /** `buildLightingTracks(...)`; the docs' raw keys when undefined, null means none. */
  lightingTracks?: readonly (LightingTrack | null)[] | null;
  /** `buildCompareBLightingTracks(...).tracks`; the docs' raw keys when undefined, null means none. */
  compareBLightingTracks?: readonly (LightingTrack | null)[] | null;
  projectCameraTrack?: readonly CameraKeyframe[] | null;
  /** Display names per scene (`sceneTitle`); "Scene N" when absent. */
  sceneNames?: readonly (string | null | undefined)[];
}

export interface StillPage {
  sceneIndex: number;
  sceneName: string;
  kind: "auto" | "marked";
  /** Global frame on the export grid. */
  frame: number;
  /** Global ms: `exportFrameTimeMs(frame, fps)`. */
  tMs: number;
  /** Scene-local ms the scene renders at. */
  sceneMs: number;
  /** What the capture renders: `resolveAt(slots, tMs)`, or a synthetic solo when the scene has no solo frame. */
  resolved: Resolved;
  /** 1-based position among this scene's pages. */
  ordinal: number;
  /** This scene's page count. */
  sceneCount: number;
  /** The mark a marked page came from. */
  source?: Exclude<StillSource, { kind: "auto" }>;
}

export type StillsWarning =
  | { kind: "dormant-marks"; sceneIndex: number; sceneName: string; count: number }
  | { kind: "marks-all-dormant"; sceneIndex: number; sceneName: string; count: number }
  | { kind: "clamped"; sceneIndex: number; sceneName: string; count: number }
  | { kind: "empty-solo-window"; sceneIndex: number; sceneName: string };

export interface StillBookmark {
  sceneIndex: number;
  sceneName: string;
  /** Index into `pages` of the scene's first page. */
  pageIndex: number;
  pageCount: number;
}

export interface StillPagesPlan {
  pages: StillPage[];
  /** Hold per automatic-still scene, for `replaceSceneHolds`; marked scenes render raw frames. */
  holds: ReadonlyMap<number, number>;
  warnings: StillsWarning[];
  bookmarks: StillBookmark[];
}

function lastKeyMs(keys: readonly { tMs: number }[] | undefined): number {
  let end = 0;
  for (const key of keys ?? []) if (Number.isFinite(key?.tMs) && key.tMs > end) end = key.tMs;
  return end;
}

/** Scene-local end of the project camera's motion inside this scene (linear keys, held outside their range). */
function projectCameraEndMs(track: readonly CameraKeyframe[] | null | undefined, slot: SceneSlot) {
  const times = (track ?? []).map((k) => k.tMs).filter((t) => Number.isFinite(t));
  if (times.length < 2) return 0;
  const first = Math.min(...times);
  const last = Math.max(...times);
  if (last <= slot.startMs || first >= slot.endMs) return 0;
  return Math.min(last, slot.endMs) - slot.startMs;
}

/** The latest keyed or known motion end in the scene, scene-local ms (0 when nothing moves). */
export function sceneKnownEndMs(inputs: AutoStillInputs): number {
  const { doc, slots, index } = inputs;
  let end = 0;
  const take = (ms: number | null | undefined) => {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > end) end = ms;
  };
  if (inputs.sceneTrack) take(sceneCameraEndMs(inputs.sceneTrack));
  else if (slots[index]) take(projectCameraEndMs(inputs.projectCameraTrack, slots[index]));
  take(lastKeyMs(doc?.deviceTrack?.keys));
  take(lastKeyMs(doc?.compare?.track?.keys));
  take(lastKeyMs(doc?.chart?.track?.keys));
  if (doc?.animatedTrack === "layeredScreenshot") {
    take(lastKeyMs(doc.layeredScreenshot?.animation?.keys));
  }
  take(lastKeyMs(inputs.lightingTrack?.keys));
  take(lastKeyMs(inputs.compareBLightingTrack?.keys));
  const chart = resolveChart(doc);
  if (chart) {
    take(
      chartAnimationEndMs(chart.animation, {
        seriesCount: chart.data.series.length,
        categoryCount: chart.data.categories.length,
        type: chart.type,
      }),
    );
  }
  for (const entry of resolveSceneDocMedia(doc))
    take(sceneMediaMotionEndMs(entry.kind, entry.motion));
  return end;
}

/** One scene's automatic still: Present's hold, then on to the latest keyed or known end (capped only by an authored outro, never below the hold); the solo-window centre when nothing registered or keyed. */
export function autoStillLocalMs(inputs: AutoStillInputs): AutoStill {
  const slot = inputs.slots[inputs.index];
  if (!slot) throw new RangeError(`stills: no scene at index ${inputs.index}`);
  const { holdMs } = derivePresentHold(inputs.timings, slot.durationMs);
  const known = sceneKnownEndMs(inputs);
  if (inputs.timings.length === 0 && known <= 0) {
    const window = soloWindow(inputs.slots, inputs.index);
    const centre = soloWindowIsEmpty(window)
      ? slot.durationMs / 2
      : (window.startMs + window.endMs) / 2;
    return { settledMs: centre, holdMs, basis: "centre" };
  }
  let settledMs = Math.max(holdMs, known);
  const outAts = inputs.timings
    .map((entry) => entry.outAtMs)
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms));
  if (outAts.length > 0) settledMs = Math.max(holdMs, Math.min(settledMs, Math.min(...outAts)));
  return { settledMs, holdMs, basis: "settled" };
}

function rawLightingTrack(lighting: SceneDoc["lighting"]): LightingTrack | null {
  if (!lighting?.keys?.length || lighting.animationEnabled === false) return null;
  return { keys: lighting.keys, segments: lighting.segments ?? [] } as LightingTrack;
}

export function planStillPages(input: StillPagesInput): StillPagesPlan {
  const { slots, sceneDocs } = input;
  const fps = input.fps ?? STILLS_FPS;
  if (slots.length === 0) throw new Error("Stills export needs at least one scene.");
  const sceneTracks =
    input.sceneTracks === undefined ? buildSceneCameraTracks(sceneDocs) : input.sceneTracks;
  const lightingTracks =
    input.lightingTracks === undefined
      ? sceneDocs.map((doc) => rawLightingTrack(doc?.lighting))
      : input.lightingTracks;
  const compareBLightingTracks =
    input.compareBLightingTracks === undefined
      ? sceneDocs.map((doc) => rawLightingTrack(doc?.compare?.b?.lighting))
      : input.compareBLightingTracks;

  const pages: StillPage[] = [];
  const holds = new Map<number, number>();
  const warnings: StillsWarning[] = [];
  const bookmarks: StillBookmark[] = [];
  let included = 0;

  for (let i = 0; i < slots.length; i++) {
    const doc = sceneDocs[i];
    const plan = sceneStillsPlan(doc, slots, i, fps);
    if (!plan.included) continue;
    included += 1;
    const sceneName = input.sceneNames?.[i] ?? sceneTitle(doc, null, null, i);
    const marks = plan.stills.filter(
      (s): s is Exclude<StillSource, { kind: "auto" }> => s.kind !== "auto",
    );
    if (plan.dormantKeyMarks > 0) {
      warnings.push({
        kind: marks.length > 0 ? "dormant-marks" : "marks-all-dormant",
        sceneIndex: i,
        sceneName,
        count: plan.dormantKeyMarks,
      });
    }
    const clamped = marks.filter((m) => m.clamped).length;
    if (clamped > 0) warnings.push({ kind: "clamped", sceneIndex: i, sceneName, count: clamped });
    if (!soloFrameRange(slots, i, fps)) {
      warnings.push({ kind: "empty-solo-window", sceneIndex: i, sceneName });
    }

    const scenePages: Omit<StillPage, "ordinal" | "sceneCount">[] = [];
    const seen = new Set<number>();
    const push = (localMs: number, mode: "ceil" | "round", source?: StillPage["source"]) => {
      const snapped = snapStillFrame(slots, i, localMs, fps, mode);
      if (seen.has(snapped.frame)) return;
      seen.add(snapped.frame);
      const tMs = exportFrameTimeMs(snapped.frame, fps);
      let resolved: Resolved;
      if (snapped.solo) {
        resolved = resolveAt(slots as SceneSlot[], tMs);
        const only = resolved.active.length === 1 ? resolved.active[0] : null;
        if (!only || only.index !== i) {
          throw new Error(`stills: frame ${snapped.frame} is not scene ${i + 1} alone`);
        }
      } else {
        resolved = { active: [{ index: i, localMs: snapped.localMs }] };
      }
      scenePages.push({
        sceneIndex: i,
        sceneName,
        kind: source ? "marked" : "auto",
        frame: snapped.frame,
        tMs,
        sceneMs: resolved.active[0].localMs,
        resolved,
        ...(source ? { source } : {}),
      });
    };

    if (marks.length === 0) {
      const auto = autoStillLocalMs({
        slots,
        index: i,
        doc,
        timings: input.timingsFor(i),
        sceneTrack: sceneTracks?.[i] ?? null,
        lightingTrack: lightingTracks?.[i] ?? null,
        compareBLightingTrack: compareBLightingTracks?.[i] ?? null,
        projectCameraTrack: input.projectCameraTrack,
      });
      holds.set(i, auto.holdMs);
      push(auto.settledMs, "ceil");
    } else {
      for (const mark of marks) push(mark.tMs, "round", mark);
    }

    scenePages.sort((a, b) => a.frame - b.frame);
    bookmarks.push({
      sceneIndex: i,
      sceneName,
      pageIndex: pages.length,
      pageCount: scenePages.length,
    });
    scenePages.forEach((page, k) => {
      pages.push({ ...page, ordinal: k + 1, sceneCount: scenePages.length });
    });
  }

  if (included === 0) {
    throw new Error("Every scene is left out of stills, so there is nothing to export.");
  }
  return { pages, holds, warnings, bookmarks };
}
