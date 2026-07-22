import { useEffect, useRef, useState } from "react";
import { useClockStore } from "../engine/clock";
import { CAMERA } from "../engine/format";
import {
  type LayeredScreenshotAnimationDoc,
  nearestKey,
  panCentreSnap,
  playheadDriftTarget,
  setKeyPose,
} from "../engine/layeredScreenshotAnimationEdit";
import {
  type LayeredScreenshotTool,
  useLayeredScreenshotEditStore,
} from "../engine/layeredScreenshotEditStore";
import type { LoadedProject } from "../engine/project";
import type { LayeredScreenshotPose, SceneDoc } from "../engine/sceneDocSchema";
import { blockWithAnimation } from "./LayeredScreenshotAnimationLane";
import { useLayeredScreenshotDoc } from "./layeredScreenshotDoc";

/** Drag surface for the layered-screenshot pose, mounted over the preview canvas while a tool is armed (the CameraToolOverlay pattern plus the 4th spread tool). Edits follow what's displayed: an animated scene edits the selected-else-nearest animation key (seeding a lone key from the applied pose on an empty track); otherwise gestures edit the rest pose directly. Modifiers held (⌘ pan, ⌃ zoom, ⌥ orbit) swap the cursor and rebase mid-drag; pan drags snap gently to the stack centre. */

const CENTRE_SNAP_PX = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** World units per stage pixel at the content plane (pan is unscaled parent-space). */
function worldPerPx(stageH: number): number {
  const distance = CAMERA.position[2] - CAMERA.contentZ;
  return (2 * Math.tan((CAMERA.fov * Math.PI) / 360) * distance) / stageH;
}

type DragTarget =
  | { kind: "key"; keyId: string; origTrack: LayeredScreenshotAnimationDoc }
  | {
      kind: "rest";
    };

interface ToolDrag {
  target: DragTarget;
  tool: LayeredScreenshotTool;
  origPose: LayeredScreenshotPose;
  startX: number;
  startY: number;
}

/** The tool the held modifiers want: ⌘ = pan, ⌃ = zoom, ⌥ = orbit, else null (spread is armed-only). */
function modifierTool(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): LayeredScreenshotTool | null {
  return e.metaKey ? "pan" : e.ctrlKey ? "zoom" : e.altKey ? "rotate" : null;
}

/** Apply a tool drag to a stack pose: grab-style pan, orbit, exp zoom, vertical spread. */
function dragPose(
  tool: LayeredScreenshotTool,
  orig: LayeredScreenshotPose,
  dxPx: number,
  dyPx: number,
  stageW: number,
  stageH: number,
): LayeredScreenshotPose {
  if (tool === "rotate") {
    return {
      ...orig,
      pan: [...orig.pan],
      azimuthDeg: orig.azimuthDeg - (dxPx / stageW) * 200,
      elevationDeg: clamp(orig.elevationDeg + (dyPx / stageH) * 120, -85, 85),
    };
  }
  if (tool === "zoom") {
    return {
      ...orig,
      pan: [...orig.pan],
      zoom: clamp(orig.zoom * Math.exp(-(dyPx / stageH) * 2), 0.05, 20),
    };
  }
  if (tool === "spread") {
    return {
      ...orig,
      pan: [...orig.pan],
      spread: clamp(orig.spread - (dyPx / stageH) * 1.2, 0, 1),
    };
  }
  // Pan: grab-style in world units at the content plane (content follows the pointer).
  const wpp = worldPerPx(stageH);
  return { ...orig, pan: [orig.pan[0] + dxPx * wpp, orig.pan[1] - dyPx * wpp] };
}

export function LayeredScreenshotToolOverlay({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const armedTool = useLayeredScreenshotEditStore((s) => s.armedTool);
  const { doc, block, preview, commit, appliedPoseAt } = useLayeredScreenshotDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  const slot = project.slots[sceneIndex];
  const [drag, setDrag] = useState<ToolDrag | null>(null);
  const [guides, setGuides] = useState({ v: false, h: false });
  const [heldTool, setHeldTool] = useState<LayeredScreenshotTool | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Cursor feedback while a modifier is held, before any drag starts.
  useEffect(() => {
    const update = (e: KeyboardEvent) => setHeldTool(modifierTool(e));
    const clear = () => setHeldTool(null);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
    };
  }, []);

  if (!armedTool) return null;

  const animated = doc?.animatedTrack === "layeredScreenshot";
  const track: LayeredScreenshotAnimationDoc = block.animation ?? { keys: [], segments: [] };

  function setGuideState(v: boolean, h: boolean) {
    setGuides((prev) => (prev.v === v && prev.h === h ? prev : { v, h }));
  }

  /** Write `pose` through the drag's target: key edit on the animation track, else the rest pose. */
  function writePose(target: DragTarget, pose: LayeredScreenshotPose, committed: boolean) {
    const next =
      target.kind === "key"
        ? (() => {
            const t = setKeyPose(target.origTrack, target.keyId, pose);
            return t ? blockWithAnimation(block, t) : null;
          })()
        : { ...block, pose };
    if (!next) return;
    if (committed) void commit(next);
    else preview(next, false);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || !armedTool) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const state = useLayeredScreenshotEditStore.getState();
    let target: DragTarget;
    let origPose: LayeredScreenshotPose;
    if (animated) {
      let playheadLocal = Math.min(
        slot.durationMs,
        Math.max(0, useClockStore.getState().currentMs - slot.startMs),
      );
      // Drift to the 25% point of the containing animation first, so the pose edit stays visible mid-span.
      const drift = playheadDriftTarget(track, playheadLocal);
      if (drift !== null) {
        const clock = useClockStore.getState();
        clock.setCurrentMs(Math.min(clock.durationMs, slot.startMs + drift));
        playheadLocal = drift;
      }
      let origTrack = track;
      let key =
        origTrack.keys.find((k) => k.id === state.selectedKeyId) ??
        nearestKey(origTrack, playheadLocal);
      if (!key) {
        // Empty track: a lone key at 0 seeded from the applied pose = static reframe.
        key = { id: "k1", tMs: 0, pose: appliedPoseAt(playheadLocal) };
        origTrack = { keys: [key], segments: [] };
      }
      target = { kind: "key", keyId: key.id, origTrack };
      origPose = { ...key.pose, pan: [...key.pose.pan] };
      state.selectKey(key.id, null);
    } else {
      target = { kind: "rest" };
      origPose = { ...block.pose, pan: [...block.pose.pan] };
    }
    setDrag({
      target,
      tool: modifierTool(e) ?? armedTool,
      origPose,
      startX: e.clientX,
      startY: e.clientY,
    });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag || !armedTool) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    // A modifier change mid-drag rebases the drag on the current pose; reinterpreting the accumulated delta under a new tool would jump.
    const want = modifierTool(e) ?? armedTool;
    let base = drag;
    if (want !== drag.tool) {
      const target = drag.target;
      const current =
        target.kind === "key"
          ? (track.keys.find((k) => k.id === target.keyId)?.pose ?? drag.origPose)
          : block.pose;
      base = {
        ...drag,
        tool: want,
        origPose: { ...current, pan: [...current.pan] },
        startX: e.clientX,
        startY: e.clientY,
      };
      setDrag(base);
    }
    const dx = e.clientX - base.startX;
    const dy = e.clientY - base.startY;
    let pose = dragPose(base.tool, base.origPose, dx, dy, rect.width, rect.height);
    if (base.tool === "pan") {
      // Keynote-style centre capture: light (a few pixels' worth), so it never fights the drag.
      const snap = panCentreSnap(pose, CENTRE_SNAP_PX * worldPerPx(rect.height));
      pose = snap.pose;
      setGuideState(snap.snappedX, snap.snappedY);
    } else {
      setGuideState(false, false);
    }
    writePose(base.target, pose, false);
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!drag) return;
    setGuideState(false, false);
    const rect = overlayRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      let pose = dragPose(drag.tool, drag.origPose, dx, dy, rect.width, rect.height);
      if (drag.tool === "pan") {
        pose = panCentreSnap(pose, CENTRE_SNAP_PX * worldPerPx(rect.height)).pose;
      }
      writePose(drag.target, pose, true);
    }
    setDrag(null);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a pure drag surface over the canvas — the contextmenu handler only swallows macOS ⌃-click during ⌃-zoom drags
    <div
      ref={overlayRef}
      className={`camera-tool-overlay tool-${drag?.tool ?? heldTool ?? armedTool}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {guides.v && <div className="camera-centre-guide v" />}
      {guides.h && <div className="camera-centre-guide h" />}
    </div>
  );
}
