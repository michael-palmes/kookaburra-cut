/** Pure stills view logic shared by the Stills drill, the timeline ticks, the scene menus and App's playhead mark. It reads the engine's stills contract (frame snapping included) and is unit-pinned, so the components stay layout only. */

import type { SceneDoc } from "../engine/sceneDocSchema";
import type { SceneSlot } from "../engine/sceneTimeline";
import {
  activeCameraBlock,
  type CameraBlock,
  type SceneStillsPlan,
  STILLS_FPS,
  type StillSource,
  sceneStillsPlan,
  snapStillFrame,
} from "../engine/stills";

/** Scene-local ms of the export frame under the playhead, as the whole ms a time mark stores. */
export function playheadStillMs(
  currentMs: number,
  slotStartMs: number,
  fps: number = STILLS_FPS,
): number {
  const frame = Math.round((currentMs * fps) / 1000);
  return Math.max(0, Math.round((frame * 1000) / fps - slotStartMs));
}

export function isStillKey(key: { still?: true }): boolean {
  return key.still === true;
}

/** Every marked still (key and time) in included scenes at its global ms, for the timeline ticks. */
export function stillTickTimes(
  docs: readonly (SceneDoc | undefined)[],
  slots: readonly SceneSlot[],
): { id: string; ms: number }[] {
  const out: { id: string; ms: number }[] = [];
  slots.forEach((slot, i) => {
    for (const still of sceneStillsPlan(docs[i], slots, i).stills) {
      if (still.kind === "auto") continue;
      const id = still.kind === "key" ? `${i}:${still.block}:${still.keyId}` : `${i}:t${still.tMs}`;
      out.push({ id, ms: slot.startMs + still.tMs });
    }
  });
  return out;
}

export interface StillRow {
  id: string;
  kind: StillSource["kind"];
  label: string;
  tMs: number | null;
  clamped: boolean;
  keyId?: string;
  block?: CameraBlock;
}

/** One drill row per still: "Automatic", "Camera key N" (N by time order within its block) or "Fixed time". */
export function stillRows(plan: SceneStillsPlan, doc: SceneDoc | undefined): StillRow[] {
  return plan.stills.map((still) => {
    if (still.kind === "auto") {
      return { id: "auto", kind: "auto", label: "Automatic", tMs: null, clamped: false };
    }
    if (still.kind === "time") {
      return {
        id: `time:${still.tMs}`,
        kind: "time",
        label: "Fixed time",
        tMs: still.tMs,
        clamped: still.clamped,
      };
    }
    const block = still.block === "cameraRig" ? doc?.cameraRig : doc?.camera;
    const keys = [...(block?.keys ?? [])].sort((a, b) => a.tMs - b.tMs);
    const ordinal = keys.findIndex((k) => k.id === still.keyId) + 1;
    return {
      id: `key:${still.block}:${still.keyId}`,
      kind: "key",
      label: ordinal > 0 ? `Camera key ${ordinal}` : "Camera key",
      tMs: still.tMs,
      clamped: still.clamped,
      keyId: still.keyId,
      block: still.block,
    };
  });
}

/** The overview row's value: Left out, Automatic, or "N marked". */
export function stillsOverviewValue(plan: SceneStillsPlan): string {
  if (!plan.included) return "Left out";
  const marked = plan.stills.filter((s) => s.kind !== "auto").length;
  return marked > 0 ? `${marked} marked` : "Automatic";
}

/** Why marks on the idle camera block do nothing, e.g. "2 stills marked on the orbit camera are ignored while Free drives this scene." */
export function dormantStillsHint(count: number, doc: SceneDoc | undefined): string | null {
  if (count <= 0) return null;
  const stills = count === 1 ? "1 still" : `${count} stills`;
  const verb = count === 1 ? "is" : "are";
  if (doc?.animatedTrack === "layeredScreenshot") {
    return `${stills} marked on the camera ${verb} ignored while the screenshot stack drives this scene.`;
  }
  const active = activeCameraBlock(doc);
  const free = active === "cameraRig" || (active === null && doc?.cameraMode === "rig");
  return `${stills} marked on the ${free ? "orbit" : "free"} camera ${verb} ignored while ${free ? "Free" : "Orbit"} drives this scene.`;
}

/** A planned marked still already exports the frame `localMs` lands on. */
export function stillAtFrame(
  plan: SceneStillsPlan,
  slots: readonly SceneSlot[],
  index: number,
  localMs: number,
): boolean {
  if (!slots[index]) return false;
  const frame = snapStillFrame(slots, index, localMs).frame;
  return plan.stills.some(
    (s) => s.kind !== "auto" && snapStillFrame(slots, index, s.tMs).frame === frame,
  );
}

/** The raw sidecar marks behind one planned time still: every mark that snaps to its frame (a clamped edge can gather several). */
export function rawMarksForTimeStill(
  marksMs: readonly number[],
  tMs: number,
  slots: readonly SceneSlot[],
  index: number,
): number[] {
  if (!slots[index]) return [];
  const frame = snapStillFrame(slots, index, tMs).frame;
  return marksMs.filter(
    (m) => Number.isFinite(m) && snapStillFrame(slots, index, Math.max(0, m)).frame === frame,
  );
}

/** Bulk scene-menu direction: include only when every chosen scene is already left out. */
export function stillsMenuIncludes(
  docs: readonly (SceneDoc | undefined)[],
  indices: readonly number[],
): boolean {
  return indices.length > 0 && indices.every((i) => docs[i]?.stills?.exclude === true);
}
