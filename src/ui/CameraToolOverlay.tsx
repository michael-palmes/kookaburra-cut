import { useRef, useState } from "react";
import { type CameraTool, useCameraEditStore } from "../engine/cameraEditStore";
import { useClockStore } from "../engine/clock";
import { CAMERA } from "../engine/format";
import type { LoadedProject } from "../engine/project";
import { defaultOrbitPose } from "../engine/sceneCamera";
import type { CameraDoc, RigDoc } from "../engine/sceneCameraEdit";
import {
  nearestKey,
  panCentreSnap,
  playheadDriftTarget,
  setKeyPose,
} from "../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocCameraPose, SceneDocRigPose } from "../engine/sceneDocSchema";
import { defaultRigPose } from "../engine/sceneRig";
import { forwardRigPose, lookRigPose, moveRigPose, tiltRigPose } from "../engine/sceneRigEdit";
import { toolMatchesMode } from "./CameraPill";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { useCameraDoc } from "./cameraDoc";
import { useModifierKeys } from "./gizmo/modifierKeys";
import { useGizmoYield } from "./gizmo/useGizmoYield";

/** Drag surface mounted over the preview canvas while a tool is armed (DOM above the canvas, so the export can't see it by construction); edits the selected key, else the one nearest the playhead, seeding a lone key at t=0 on an empty track. Modifiers held swap the cursor while hovering and rebase mid-drag from the current pose so the tool switch never jumps (⌘/⌃/⌥ map to the current mode's equivalents: pan/zoom/orbit in Orbit, move/forward/look in Free); ⌃-click is macOS's secondary click, so the overlay also swallows contextmenu. Pan drags snap gently to the scene centre (guide lines flash while captured). It claims the WHOLE frame, so it stands down (`is-inert`) while a registered 3D gizmo handle sits under the pointer, unless a modifier is held or a drag is already in flight (`useGizmoYield`). */

/** Pointer distance within which a pan drag captures onto the scene centre, per axis. */
const CENTRE_SNAP_PX = 8;

interface ToolDrag {
  keyId: string;
  tool: CameraTool;
  origPose: SceneDocCameraPose;
  origCamera: CameraDoc;
  /** The key exists only in this drag until a move previews it. */
  seeded: boolean;
  startX: number;
  startY: number;
}

interface RigDrag {
  keyId: string;
  tool: CameraTool;
  origPose: SceneDocRigPose;
  origRig: RigDoc;
  fov: number;
  seeded: boolean;
  startX: number;
  startY: number;
}

/** The tool the held modifiers want, in the current mode's vocabulary: ⌘ slides, ⌃ dollies, ⌥ turns. Tilt has no modifier, matching orbit's three. */
function modifierTool(
  e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  free: boolean,
): CameraTool | null {
  if (e.metaKey) return free ? "move" : "pan";
  if (e.ctrlKey) return free ? "forward" : "zoom";
  if (e.altKey) return free ? "look" : "rotate";
  return null;
}

/** Apply a free-mode drag; each tool's maths is a pure function in `sceneRigEdit.ts`. */
function dragRigPose(
  tool: CameraTool,
  orig: SceneDocRigPose,
  dxPx: number,
  dyPx: number,
  stageW: number,
  stageH: number,
  fov: number,
): SceneDocRigPose {
  if (tool === "forward") return forwardRigPose(orig, dyPx, stageH);
  if (tool === "look") return lookRigPose(orig, dxPx, dyPx, stageW, stageH);
  if (tool === "tilt") return tiltRigPose(orig, dxPx, stageW);
  return moveRigPose(orig, dxPx, dyPx, fov, stageH);
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
  const {
    slot,
    mode,
    camera,
    rig,
    preview,
    previewRig,
    commit,
    commitRig,
    appliedPoseAt,
    appliedRigAt,
    inheritedFov,
  } = useCameraDoc(project, sceneIndex, onDocChanged);
  const free = mode === "rig";
  const [drag, setDrag] = useState<ToolDrag | null>(null);
  const [rigDrag, setRigDrag] = useState<RigDrag | null>(null);
  const [guides, setGuides] = useState({ v: false, h: false });
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const mods = useModifierKeys();
  // Cursor feedback while a modifier is held, before any drag starts.
  const heldTool = modifierTool(mods, free);
  // An armed tool from the other mode (a mode switch mid-session) drags nothing rather than mangling the pose.
  const armed = !!armedTool && toolMatchesMode(armedTool, mode);
  // 3D gizmo handles win the pointer: this surface claims the whole frame, and drei's controls listen on the canvas below it.
  const { inert, gizmoClaimedPointer } = useGizmoYield(armed, drag !== null || rigDrag !== null);

  if (!armed || !armedTool) return null;

  function setGuideState(v: boolean, h: boolean) {
    setGuides((prev) => (prev.v === v && prev.h === h ? prev : { v, h }));
  }

  /** Park the playhead somewhere the edit is visible, and return the scene-local time to seed from. */
  function anchorPlayhead(track: { keys: { id: string; tMs: number }[] }): number {
    let playheadLocal = Math.min(
      slot.durationMs,
      Math.max(0, useClockStore.getState().currentMs - slot.startMs),
    );
    // Drift to the 25% point of the containing animation first, so the pose edit stays visible mid-span.
    const drift = playheadDriftTarget(track as never, playheadLocal);
    if (drift !== null) {
      const clock = useClockStore.getState();
      clock.setCurrentMs(Math.min(clock.durationMs, slot.startMs + drift));
      playheadLocal = drift;
    }
    return playheadLocal;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || !armedTool) return;
    // The router latches a handle on the window capture phase, i.e. before this fires, so a hover miss can't fly the camera on top of a gizmo drag.
    if (gizmoClaimedPointer()) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const state = useCameraEditStore.getState();
    if (free) {
      const playheadLocal = anchorPlayhead(rig);
      let track = rig;
      let key =
        track.keys.find((k) => k.id === state.selectedKeyId) ?? nearestKey(track, playheadLocal);
      const seeded = !key;
      if (!key) {
        key = { id: "k1", tMs: 0, pose: appliedRigAt(playheadLocal) };
        track = { keys: [key], segments: [] };
      }
      setRigDrag({
        keyId: key.id,
        tool: modifierTool(e, true) ?? armedTool,
        origPose: { ...key.pose, position: [...key.pose.position], aim: { ...key.pose.aim } },
        origRig: track,
        fov: key.pose.fov ?? inheritedFov(playheadLocal),
        seeded,
        startX: e.clientX,
        startY: e.clientY,
      });
      if (!seeded) state.select(key.id, null);
      return;
    }
    const playheadLocal = anchorPlayhead(camera);
    let cam = camera;
    let key = cam.keys.find((k) => k.id === state.selectedKeyId) ?? nearestKey(cam, playheadLocal);
    const seeded = !key;
    if (!key) {
      // Empty track: a lone key at 0 seeded from the applied pose = static reframe.
      key = { id: "k1", tMs: 0, pose: appliedPoseAt(playheadLocal) };
      cam = { keys: [key], segments: [] };
    }
    setDrag({
      keyId: key.id,
      tool: modifierTool(e, false) ?? armedTool,
      origPose: { ...key.pose, target: [...key.pose.target] },
      origCamera: cam,
      seeded,
      startX: e.clientX,
      startY: e.clientY,
    });
    if (!seeded) state.select(key.id, null);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!armedTool) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    if (rigDrag) {
      // A modifier change mid-drag rebases on the current pose; reinterpreting the accumulated delta under a new tool would jump.
      const want = modifierTool(e, true) ?? armedTool;
      let base = rigDrag;
      if (want !== rigDrag.tool) {
        const key = rig.keys.find((k) => k.id === rigDrag.keyId);
        base = {
          ...rigDrag,
          tool: want,
          origPose: key
            ? { ...key.pose, position: [...key.pose.position], aim: { ...key.pose.aim } }
            : rigDrag.origPose,
          origRig: rig,
          startX: e.clientX,
          startY: e.clientY,
        };
        setRigDrag(base);
      }
      const pose = dragRigPose(
        base.tool,
        base.origPose,
        e.clientX - base.startX,
        e.clientY - base.startY,
        rect.width,
        rect.height,
        base.fov,
      );
      const next = setKeyPose(base.origRig, base.keyId, pose);
      if (next) previewRig(next as RigDoc, false);
      return;
    }
    if (!drag) return;
    const want = modifierTool(e, false) ?? armedTool;
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
    let pose = dragPose(base.tool, base.origPose, dx, dy, rect.width, rect.height);
    if (base.tool === "pan") {
      // Keynote-style centre capture: light (a few pixels' worth), so it never fights the drag.
      const worldPerPx = (2 * Math.tan((CAMERA.fov * Math.PI) / 360) * pose.distance) / rect.height;
      const snap = panCentreSnap(pose, defaultOrbitPose().target, CENTRE_SNAP_PX * worldPerPx);
      pose = snap.pose;
      setGuideState(snap.snappedX, snap.snappedY);
    } else {
      setGuideState(false, false);
    }
    const next = setKeyPose(base.origCamera, base.keyId, pose);
    if (next) preview(next, false);
  }

  /** Whether a finished drag has anything to write: a seed no move ever previewed exists nowhere, so it writes nothing and selects nothing. */
  function landed(seeded: boolean, keyId: string, track: { keys: { id: string }[] }): boolean {
    if (!seeded) return true;
    if (!track.keys.some((k) => k.id === keyId)) return false;
    useCameraEditStore.getState().select(keyId, null);
    return true;
  }

  function onPointerUp() {
    if (rigDrag) {
      if (landed(rigDrag.seeded, rigDrag.keyId, rig)) void commitRig(rig);
      setRigDrag(null);
      return;
    }
    if (!drag) return;
    setGuideState(false, false);
    if (landed(drag.seeded, drag.keyId, camera)) void commit(camera);
    setDrag(null);
  }

  /** Right-click camera menu; ⌃-left-click stays swallowed (it is the zoom modifier here, macOS fires contextmenu for it), but a real secondary button opens the menu even with ⌃ held. */
  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if ((e.ctrlKey && e.button !== 2) || drag || rigDrag) return;
    setMenuAt({ x: e.clientX, y: e.clientY });
  }

  // Menu items derive from the CURRENT track every render, so an edit made while the menu sits open (lane keyboard shortcuts) can never be reverted by a stale closure.
  const playheadLocal = Math.min(
    slot.durationMs,
    Math.max(0, useClockStore.getState().currentMs - slot.startMs),
  );
  const selectedId = useCameraEditStore.getState().selectedKeyId;
  const menuTargetKey = free
    ? (rig.keys.find((k) => k.id === selectedId) ?? nearestKey(rig, playheadLocal))
    : (camera.keys.find((k) => k.id === selectedId) ?? nearestKey(camera, playheadLocal));
  const trackKeyCount = free ? rig.keys.length : camera.keys.length;
  const menu: ContextMenuState | null = menuAt
    ? {
        x: menuAt.x,
        y: menuAt.y,
        items: [
          {
            id: "reset",
            label: "Reset to default pose",
            disabled: !menuTargetKey,
            title: "Reset this key to the scene-default pose",
            onSelect: () => {
              if (!menuTargetKey) return;
              if (free) {
                const next = setKeyPose(rig, menuTargetKey.id, defaultRigPose());
                if (next) void commitRig(next as RigDoc);
              } else {
                const cam = setKeyPose(camera, menuTargetKey.id, defaultOrbitPose());
                if (cam) void commit(cam);
              }
            },
          },
          {
            id: "clear",
            label: "Clear all camera keyframes",
            confirmLabel: "Really clear?",
            danger: true,
            disabled: trackKeyCount === 0,
            onSelect: () =>
              free
                ? void commitRig({ ...rig, keys: [], segments: [] })
                : void commit({ ...camera, keys: [], segments: [] }),
          },
        ],
      }
    : null;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pure drag surface over the canvas — contextmenu opens the camera menu (⌃-left-click stays swallowed as the zoom modifier) */}
      <div
        ref={overlayRef}
        className={`camera-tool-overlay tool-${rigDrag?.tool ?? drag?.tool ?? heldTool ?? armedTool}${inert ? " is-inert" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
      >
        {guides.v && <div className="camera-centre-guide v" />}
        {guides.h && <div className="camera-centre-guide h" />}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenuAt(null)} />}
    </>
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
