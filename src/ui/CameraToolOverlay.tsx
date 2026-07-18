import { useRef, useState } from "react";
import { type CameraTool, useCameraEditStore } from "../engine/cameraEditStore";
import { useClockStore } from "../engine/clock";
import { CAMERA } from "../engine/format";
import type { LoadedProject } from "../engine/project";
import type { CameraDoc } from "../engine/sceneCameraEdit";
import { nearestKey, playheadDriftTarget, setKeyPose } from "../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocCameraPose } from "../engine/sceneDocSchema";
import { useCameraDoc } from "./cameraDoc";

/** Drag surface mounted over the preview canvas while a tool is armed (DOM above the canvas, so the export can't see it by construction); edits the selected key, else the one nearest the playhead, seeding a lone key at t=0 on an empty track. Modifiers held mid-drag (⌘ pan, ⌃ zoom) rebase the drag from the current pose so the tool switch never jumps; ⌃-click is macOS's secondary click, so the overlay also swallows contextmenu. */

interface ToolDrag {
  keyId: string;
  tool: CameraTool;
  origPose: SceneDocCameraPose;
  origCamera: CameraDoc;
  startX: number;
  startY: number;
}

/** The tool this event wants: ⌘ = pan, ⌃ = zoom, else whatever is armed. */
function effectiveTool(e: React.PointerEvent, armed: CameraTool): CameraTool {
  return e.metaKey ? "pan" : e.ctrlKey ? "zoom" : armed;
}

export function CameraToolOverlay({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const armedTool = useCameraEditStore((s) => s.armedTool);
  const { slot, camera, preview, commit, appliedPoseAt } = useCameraDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  const [drag, setDrag] = useState<ToolDrag | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  if (!armedTool) return null;

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || !armedTool) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const state = useCameraEditStore.getState();
    let playheadLocal = Math.min(
      slot.durationMs,
      Math.max(0, useClockStore.getState().currentMs - slot.startMs),
    );
    // Drift to the 25% point of the containing animation first, so the pose edit stays visible mid-span.
    const drift = playheadDriftTarget(camera, playheadLocal);
    if (drift !== null) {
      const clock = useClockStore.getState();
      clock.setCurrentMs(Math.min(clock.durationMs, slot.startMs + drift));
      playheadLocal = drift;
    }
    let cam = camera;
    let key = cam.keys.find((k) => k.id === state.selectedKeyId) ?? nearestKey(cam, playheadLocal);
    if (!key) {
      // Empty track: a lone key at 0 seeded from the applied pose = static reframe.
      key = { id: "k1", tMs: 0, pose: appliedPoseAt(playheadLocal) };
      cam = { keys: [key], segments: [] };
    }
    setDrag({
      keyId: key.id,
      tool: effectiveTool(e, armedTool),
      origPose: { ...key.pose, target: [...key.pose.target] },
      origCamera: cam,
      startX: e.clientX,
      startY: e.clientY,
    });
    state.select(key.id, null);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag || !armedTool) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    // A modifier change mid-drag rebases the drag on the current pose; reinterpreting the accumulated delta under a new tool would jump.
    const want = effectiveTool(e, armedTool);
    let base = drag;
    if (want !== drag.tool) {
      const key = camera.keys.find((k) => k.id === drag.keyId);
      base = {
        ...drag,
        tool: want,
        origPose: key ? { ...key.pose, target: [...key.pose.target] } : drag.origPose,
        origCamera: camera,
        startX: e.clientX,
        startY: e.clientY,
      };
      setDrag(base);
    }
    const dx = e.clientX - base.startX;
    const dy = e.clientY - base.startY;
    const next = setKeyPose(
      base.origCamera,
      base.keyId,
      dragPose(base.tool, base.origPose, dx, dy, rect.width, rect.height),
    );
    if (next) preview(next, false);
  }

  function onPointerUp() {
    if (!drag) return;
    void commit(camera);
    setDrag(null);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a pure drag surface over the canvas — the contextmenu handler only swallows macOS ⌃-click during ⌃-zoom drags
    <div
      ref={overlayRef}
      className={`camera-tool-overlay tool-${drag?.tool ?? armedTool}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

/** Apply a tool drag to an orbit pose: grab-style pan, orbit rotate, exp dolly zoom. */
function dragPose(
  tool: CameraTool,
  orig: SceneDocCameraPose,
  dxPx: number,
  dyPx: number,
  stageW: number,
  stageH: number,
): SceneDocCameraPose {
  if (tool === "rotate") {
    return {
      ...orig,
      target: [...orig.target],
      azimuthDeg: orig.azimuthDeg - (dxPx / stageW) * 200,
      elevationDeg: Math.min(85, Math.max(-85, orig.elevationDeg + (dyPx / stageH) * 120)),
    };
  }
  if (tool === "zoom") {
    return {
      ...orig,
      target: [...orig.target],
      distance: Math.min(50, Math.max(0.5, orig.distance * Math.exp((dyPx / stageH) * 2))),
    };
  }
  // Pan: move the target in the camera plane, grab-style (content follows the pointer).
  const az = (orig.azimuthDeg * Math.PI) / 180;
  const el = (orig.elevationDeg * Math.PI) / 180;
  const right = [Math.cos(az), 0, -Math.sin(az)] as const;
  const up = [-Math.sin(az) * Math.sin(el), Math.cos(el), -Math.cos(az) * Math.sin(el)] as const;
  const worldPerPx = (2 * Math.tan((CAMERA.fov * Math.PI) / 360) * orig.distance) / stageH;
  const wx = dxPx * worldPerPx;
  const wy = dyPx * worldPerPx;
  return {
    ...orig,
    target: [
      orig.target[0] - right[0] * wx + up[0] * wy,
      orig.target[1] - right[1] * wx + up[1] * wy,
      orig.target[2] - right[2] * wx + up[2] * wy,
    ],
  };
}
