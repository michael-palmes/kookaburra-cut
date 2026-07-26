import { useEffect, useMemo, useRef, useState } from "react";
import { checkCameraBounds } from "../engine/cameraBounds";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { clampToStage, projectToStage, viewBasis, worldPerPixel } from "../engine/cameraProject";
import type { CameraPose } from "../engine/cameraTrack";
import { useClockStore } from "../engine/clock";
import { useSceneIsBanded } from "../engine/depthStageRegistry";
import type { LoadedProject } from "../engine/project";
import type { RigDoc } from "../engine/sceneCameraEdit";
import { setKeyPose } from "../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocRigPose } from "../engine/sceneDocSchema";
import { normalizeSceneRig, sampleSceneRig } from "../engine/sceneRig";
import { rigBasis } from "../engine/sceneRigEdit";
import { useCameraDoc } from "./cameraDoc";

/** The ghost path: an SVG layer over the stage drawing where a free-flight rig travels, with a draggable dot per key. Projection is a pure RECOMPUTE (`engine/cameraProject.ts`) of the pose the seam would apply, never a read of the live camera, so there is no r3f bridge and the export cannot see any of this by construction. Only free mode has a path to draw; orbit keeps its existing affordances. */

/** The four world corners of what a shot frames at its own aim distance, clockwise from top-left. Pure geometry against the applied pose, the same recompute the rest of this overlay runs on. */
function keyFrameCorners(
  shot: { position: [number, number, number]; lookAt: [number, number, number] },
  fovDeg: number,
  aspect: number,
): [number, number, number][] {
  const basis = viewBasis({ position: shot.position, lookAt: shot.lookAt, fov: fovDeg });
  const dx = shot.lookAt[0] - shot.position[0];
  const dy = shot.lookAt[1] - shot.position[1];
  const dz = shot.lookAt[2] - shot.position[2];
  const distance = Math.max(0.2, Math.sqrt(dx * dx + dy * dy + dz * dz));
  const halfH = Math.tan((fovDeg * Math.PI) / 360) * distance;
  const halfW = halfH * aspect;
  const at = shot.lookAt;
  const corner = (sx: number, sy: number): [number, number, number] => [
    at[0] + basis.x[0] * halfW * sx + basis.y[0] * halfH * sy,
    at[1] + basis.x[1] * halfW * sx + basis.y[1] * halfH * sy,
    at[2] + basis.x[2] * halfW * sx + basis.y[2] * halfH * sy,
  ];
  return [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
}

/** How finely the path is sampled, in scene-local ms; small enough that a smoothed segment reads as a curve. */
const SAMPLE_STEP_MS = 50;
/** Never draw more than this many points, however long the scene. */
const MAX_SAMPLES = 400;

interface DotDrag {
  keyId: string;
  origPose: SceneDocRigPose;
  origRig: RigDoc;
  /** World units per pixel at the key's depth from the VIEWING pose, so the dot tracks the pointer. */
  perPx: number;
  view: CameraPose;
  startX: number;
  startY: number;
}

export function CameraPathOverlay({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const open = useCameraEditStore((s) => s.open);
  const selectedKeyId = useCameraEditStore((s) => s.selectedKeyId);
  const { slot, doc, mode, rig, previewRig, commitRig, appliedViewAt } = useCameraDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  const currentMs = useClockStore((s) => s.currentMs);
  const banded = useSceneIsBanded(sceneIndex);
  const [rect, setRect] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<DotDrag | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setRect((prev) =>
        prev.width === box.width && prev.height === box.height
          ? prev
          : { width: box.width, height: box.height },
      );
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const localMs = Math.min(slot.durationMs, Math.max(0, currentMs - slot.startMs));
  const aspect = rect.height > 0 ? rect.width / rect.height : 1;
  // The path is drawn through the pose the frame is CURRENTLY showing, so it moves with the shot rather than sitting in a fixed projection.
  const view = appliedViewAt(localMs);

  const track = useMemo(
    () =>
      mode === "rig" && rig.keys.length > 0 ? normalizeSceneRig(rig, "path-overlay", doc) : null,
    [mode, rig, doc],
  );

  // The path's WORLD shape and each key's bounds verdict are pure functions of the track: they
  // recompute on a doc change, never per frame. Only the projection follows the playhead.
  const shape = useMemo(() => {
    if (!track) return null;
    const first = track.keys[0].tMs;
    const last = track.keys[track.keys.length - 1].tMs;
    const span = Math.max(0, last - first);
    const step = Math.max(SAMPLE_STEP_MS, span / MAX_SAMPLES);
    const world: [number, number, number][] = [];
    for (let t = first; t <= last + 1e-6; t += step) {
      world.push(sampleSceneRig(track, t).position);
    }
    // A track whose segments are all straight draws dashed, so the smoothing state is legible without opening a popover.
    return { world, anySmooth: track.segments.some((s) => s.smooth) };
  }, [track]);

  const verdicts = useMemo(() => {
    if (!track) return new Map<string, ReturnType<typeof checkCameraBounds>>();
    return new Map(
      track.keys.map((key) => {
        const pose = sampleSceneRig(track, key.tMs);
        return [
          key.id,
          checkCameraBounds(
            {
              position: pose.position,
              lookAt: pose.lookAt,
              fov: pose.fov ?? 45,
              rollDeg: pose.rollDeg,
            },
            aspect,
            doc,
            undefined,
            banded,
          ),
        ] as const;
      }),
    );
  }, [track, aspect, doc, banded]);

  const path = useMemo(() => {
    if (!track || !shape || rect.width === 0) return null;
    const points: string[] = [];
    for (const world of shape.world) {
      const p = projectToStage(world, view, rect, aspect);
      if (!p.clipped) points.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    const dots = track.keys.map((key) => {
      const raw = projectToStage(key.pose.position, view, rect, aspect);
      return {
        key,
        point: clampToStage(raw, rect),
        clipped: raw.clipped,
        bounds: verdicts.get(key.id) ?? { ok: true },
      };
    });
    const head = projectToStage(sampleSceneRig(track, localMs).position, view, rect, aspect);
    // With a key selected, draw the rectangle THAT key frames, projected through the current view,
    // so a key composes like a real shot without having to sit on it.
    const selected = track.keys.find((k) => k.id === selectedKeyId);
    let safe: string | null = null;
    if (selected) {
      const shot = sampleSceneRig(track, selected.tMs);
      const projected = keyFrameCorners(shot, shot.fov ?? view.fov, aspect).map((corner) =>
        projectToStage(corner, view, rect, aspect),
      );
      // A frame with any corner behind the camera has no honest outline; draw nothing.
      if (projected.every((p) => !p.clipped)) {
        safe = projected.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      }
    }
    return { points: points.join(" "), dots, anySmooth: shape.anySmooth, head, safe };
  }, [track, shape, verdicts, view, rect, aspect, localMs, selectedKeyId]);

  if (!open || mode !== "rig" || !path || rect.width === 0) {
    return <div ref={hostRef} className="camera-path-overlay" aria-hidden="true" />;
  }

  function onDotDown(e: React.PointerEvent, keyId: string) {
    if (e.button !== 0 || !track) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const key = rig.keys.find((k) => k.id === keyId);
    if (!key) return;
    const projected = projectToStage(key.pose.position, view, rect, aspect);
    setDrag({
      keyId,
      origPose: { ...key.pose, position: [...key.pose.position], aim: { ...key.pose.aim } },
      origRig: rig,
      perPx: worldPerPixel(view, rect.height, Math.max(0.2, projected.depth)),
      view,
      startX: e.clientX,
      startY: e.clientY,
    });
    useCameraEditStore.getState().select(keyId, null);
  }

  function onDotMove(e: React.PointerEvent) {
    if (!drag) return;
    e.stopPropagation();
    // View-plane drag: the same right/up basis the Move tool uses, at the KEY's depth.
    const basis = rigBasis({
      position: drag.view.position,
      aim: { mode: "point", at: drag.view.lookAt },
    });
    const wx = (e.clientX - drag.startX) * drag.perPx;
    const wy = -(e.clientY - drag.startY) * drag.perPx;
    const shift: [number, number, number] = [
      basis.right[0] * wx + basis.up[0] * wy,
      basis.right[1] * wx + basis.up[1] * wy,
      basis.right[2] * wx + basis.up[2] * wy,
    ];
    const pose: SceneDocRigPose = {
      ...drag.origPose,
      aim: { ...drag.origPose.aim },
      position: [
        drag.origPose.position[0] + shift[0],
        drag.origPose.position[1] + shift[1],
        drag.origPose.position[2] + shift[2],
      ],
    };
    const next = setKeyPose(drag.origRig, drag.keyId, pose);
    if (next) previewRig(next as RigDoc, false);
  }

  function onDotUp() {
    if (!drag) return;
    void commitRig(rig);
    setDrag(null);
  }

  return (
    <div ref={hostRef} className="camera-path-overlay">
      <svg
        className="camera-path-svg"
        viewBox={`0 0 ${rect.width} ${rect.height}`}
        width={rect.width}
        height={rect.height}
        aria-hidden="true"
      >
        <title>Camera path</title>
        {path.points && (
          <polyline
            className={`camera-path-line${path.anySmooth ? "" : " straight"}`}
            points={path.points}
          />
        )}
        {path.safe && <polygon className="camera-path-safe" points={path.safe} />}
        {!path.head.clipped && (
          <circle className="camera-path-head" cx={path.head.x} cy={path.head.y} r={4} />
        )}
      </svg>
      {path.dots.map(({ key, point, clipped, bounds }) => (
        <button
          type="button"
          key={key.id}
          className={[
            "camera-path-dot",
            key.id === selectedKeyId ? "selected" : "",
            clipped ? "clipped" : "",
            bounds.ok ? "" : "warn",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ left: `${point.x}px`, top: `${point.y}px` }}
          title={
            bounds.ok
              ? `Key at ${Math.round(key.tMs)}ms — drag to move it in the view plane`
              : `Key at ${Math.round(key.tMs)}ms — ${bounds.reason}`
          }
          aria-label={`Camera key at ${Math.round(key.tMs)} milliseconds`}
          onPointerDown={(e) => onDotDown(e, key.id)}
          onPointerMove={onDotMove}
          onPointerUp={onDotUp}
        />
      ))}
    </div>
  );
}
