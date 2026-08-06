import { useCallback, useEffect, useRef, useState } from "react";
import type { StageRect } from "../../engine/gizmoRegistry";
import {
  aabbHalfExtents,
  type Gizmo2DFrame,
  nearestLine,
  type Pt,
  resizeBasis,
  resizeFactor,
  resolveMoveSnap,
  rotationDegAt,
  rotationDragDeg,
  SNAP_PX,
} from "./gizmo2dMath";
import { cameraOverrideHeld, GIZMO_HIT_CLASS, gizmoLayerClass } from "./gizmoRouting";
import { useModifierKeys } from "./modifierKeys";

export type { Gizmo2DFrame, Pt } from "./gizmo2dMath";

/** The one direct-manipulation layer every 2D gizmo host draws through: a box per item, corner resize, a rotate knob, smart alignment guides and the pointer plumbing. It owns no write path and no coordinate system, so decorations (a fixed linear frame map), scene text and hero charts (projected through the live camera) all share one renderer. The layer is `.gizmo-layer` at `--z-stage-gizmo`, above the camera tool surface: handle drags never reach the camera overlay and empty-area drags fall through by construction. */

/** The four resize corners: NDC sign of the offset from the centre (y up), the CSS anchor within the box, and the diagonal cursor. */
const HANDLES = [
  { id: "tl", cx: -1, cy: 1, left: "0%", top: "0%", cursor: "nwse-resize" },
  { id: "tr", cx: 1, cy: 1, left: "100%", top: "0%", cursor: "nesw-resize" },
  { id: "bl", cx: -1, cy: -1, left: "0%", top: "100%", cursor: "nesw-resize" },
  { id: "br", cx: 1, cy: -1, left: "100%", top: "100%", cursor: "nwse-resize" },
] as const;

export interface Gizmo2DItem {
  id: string;
  /** Live geometry, or null while the item is off-playhead or has not measured yet (troika's first typeset). */
  frame: (rect: StageRect) => Gizmo2DFrame | null;
  /** A missing capability draws no handle and refuses that gesture. */
  can: { move: boolean; resize: boolean; rotate: boolean };
  label?: string;
}

export type Gizmo2DGesture =
  | { kind: "move"; id: string; rect: StageRect; dxPx: number; dyPx: number }
  | { kind: "resize"; id: string; rect: StageRect; factor: number; fixedPx: Pt; diagPx: Pt }
  | {
      kind: "rotate";
      id: string;
      rect: StageRect;
      deg: number;
      /** The item's screen angle when the drag began, so a host whose own field is not that angle applies `deg - deg0` as a turn. */
      deg0: number;
    };

export interface Gizmo2DProps {
  items: readonly Gizmo2DItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Where a corner resize keeps the geometry fixed: the item's own pivot (text, charts) or the opposite corner (decorations). */
  resizeAbout: "pivot" | "opposite-corner";
  /** Frame-level snap lines in client px; the layer adds every OTHER item's bounding box itself. */
  frameGuides: (rect: StageRect) => { x: number[]; y: number[] };
  /** Live tick during a drag: in-memory only, no disk write, no history. */
  onGesture: (g: Gizmo2DGesture) => void;
  /** Pointer-up: one disk write, one history entry. Null when the press never moved (a click that only selects). */
  onGestureEnd: (g: Gizmo2DGesture | null) => void;
  onContextMenu?: (id: string, e: React.MouseEvent) => void;
  /** True while a camera tool is armed, so a held ⌘/⌃/⌥ stands the handles down. */
  cameraArmed: boolean;
}

interface Drag {
  kind: "move" | "resize" | "rotate";
  id: string;
  rect: StageRect;
  frame0: Gizmo2DFrame;
  startX: number;
  startY: number;
  /** Pointer angle about the pivot at the grab, so a rotate drag turns the item relative to it. */
  grabDeg: number;
  fixedPx: Pt;
  diagPx: Pt;
}

interface Geometry {
  rect: StageRect;
  frames: Record<string, Gizmo2DFrame>;
}

function sameGeometry(a: Geometry | null, b: Geometry): boolean {
  if (!a) return false;
  const near = (x: number, y: number) => Math.abs(x - y) <= 0.01;
  if (
    !near(a.rect.left, b.rect.left) ||
    !near(a.rect.top, b.rect.top) ||
    !near(a.rect.width, b.rect.width) ||
    !near(a.rect.height, b.rect.height)
  ) {
    return false;
  }
  const keys = Object.keys(a.frames);
  if (keys.length !== Object.keys(b.frames).length) return false;
  for (const key of keys) {
    const p = a.frames[key];
    const q = b.frames[key];
    if (!q) return false;
    if (
      !near(p.cx, q.cx) ||
      !near(p.cy, q.cy) ||
      !near(p.w, q.w) ||
      !near(p.h, q.h) ||
      !near(p.deg, q.deg) ||
      !near(p.pivot[0], q.pivot[0]) ||
      !near(p.pivot[1], q.pivot[1])
    ) {
      return false;
    }
  }
  return true;
}

export function Gizmo2D({
  items,
  selectedId,
  onSelect,
  resizeAbout,
  frameGuides,
  onGesture,
  onGestureEnd,
  onContextMenu,
  cameraArmed,
}: Gizmo2DProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const mods = useModifierKeys();
  const [geom, setGeom] = useState<Geometry | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });
  const [dragKind, setDragKind] = useState<Drag["kind"] | null>(null);

  // Live props for the rAF loop and the window drag listeners, which mount once.
  const latest = useRef({ items, frameGuides, onGesture, onGestureEnd, onSelect, resizeAbout });
  latest.current = { items, frameGuides, onGesture, onGestureEnd, onSelect, resizeAbout };
  const geomRef = useRef<Geometry | null>(null);
  const drag = useRef<Drag | null>(null);
  const lastGesture = useRef<Gizmo2DGesture | null>(null);

  // One rAF recompute covers playback, a scrub, a camera keyframe, a rig pose, a transition, a live doc preview mid-drag, a window resize and troika's first typeset landing.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = layerRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const rect: StageRect = {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      };
      const frames: Record<string, Gizmo2DFrame> = {};
      for (const item of latest.current.items) {
        const frame = item.frame(rect);
        if (frame) frames[item.id] = frame;
      }
      const next: Geometry = { rect, frames };
      if (sameGeometry(geomRef.current, next)) return;
      geomRef.current = next;
      setGeom(next);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Deselect on a press inside the layer that missed every hit element; the container claims no events, so this rides a capture-phase window listener.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const rect = geomRef.current?.rect;
      if (!rect) return;
      if (
        e.clientX < rect.left ||
        e.clientY < rect.top ||
        e.clientX > rect.left + rect.width ||
        e.clientY > rect.top + rect.height
      ) {
        return;
      }
      const target = e.target as Element | null;
      if (target?.closest?.(`.${GIZMO_HIT_CLASS}`)) return;
      // Only a press that reaches the stage itself deselects; chrome drawn above the layer (a context menu, the camera pills) leaves the selection alone.
      if (!target?.closest?.("canvas, .camera-tool-overlay, .ls-tool-overlay")) return;
      latest.current.onSelect(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  /** Every alignment line the dragged item can snap to: the host's frame lines plus every other item's centre and bounding-box edges. */
  const snapLines = useCallback((rect: StageRect, exclude: string) => {
    const base = latest.current.frameGuides(rect);
    const x = [...base.x];
    const y = [...base.y];
    const frames = geomRef.current?.frames ?? {};
    for (const [id, frame] of Object.entries(frames)) {
      if (id === exclude) continue;
      const [ex, ey] = aabbHalfExtents(frame);
      x.push(frame.cx, frame.cx - ex, frame.cx + ex);
      y.push(frame.cy, frame.cy - ey, frame.cy + ey);
    }
    return { x, y };
  }, []);

  const endDrag = useCallback(() => {
    if (!drag.current) return;
    latest.current.onGestureEnd(lastGesture.current);
    drag.current = null;
    lastGesture.current = null;
    setDragKind(null);
    setGuides({ x: null, y: null });
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const pointer: Pt = [e.clientX, e.clientY];
      let gesture: Gizmo2DGesture;
      if (d.kind === "move") {
        let dx = e.clientX - d.startX;
        let dy = e.clientY - d.startY;
        if (e.ctrlKey) {
          setGuides({ x: null, y: null });
        } else {
          const lines = snapLines(d.rect, d.id);
          const snap = resolveMoveSnap(
            [d.frame0.cx + dx, d.frame0.cy + dy],
            aabbHalfExtents(d.frame0),
            lines.x,
            lines.y,
            SNAP_PX,
          );
          dx += snap.dx;
          dy += snap.dy;
          setGuides({ x: snap.guideX, y: snap.guideY });
        }
        gesture = { kind: "move", id: d.id, rect: d.rect, dxPx: dx, dyPx: dy };
      } else if (d.kind === "resize") {
        let factor = resizeFactor(d.fixedPx, d.diagPx, pointer);
        let guideX: number | null = null;
        let guideY: number | null = null;
        if (!e.ctrlKey) {
          // Snap the dragged corner's moving edge to a target line; aspect is locked, so only one axis snaps.
          const lines = snapLines(d.rect, d.id);
          const cx = d.fixedPx[0] + factor * d.diagPx[0];
          const cy = d.fixedPx[1] + factor * d.diagPx[1];
          const sx = d.diagPx[0] !== 0 ? nearestLine([cx], lines.x, SNAP_PX) : null;
          const sy = d.diagPx[1] !== 0 ? nearestLine([cy], lines.y, SNAP_PX) : null;
          if (sx && (!sy || Math.abs(sx.off) <= Math.abs(sy.off))) {
            factor = (sx.line - d.fixedPx[0]) / d.diagPx[0];
            guideX = sx.line;
          } else if (sy) {
            factor = (sy.line - d.fixedPx[1]) / d.diagPx[1];
            guideY = sy.line;
          }
        }
        setGuides({ x: guideX, y: guideY });
        gesture = {
          kind: "resize",
          id: d.id,
          rect: d.rect,
          factor,
          fixedPx: d.fixedPx,
          diagPx: d.diagPx,
        };
      } else {
        gesture = {
          kind: "rotate",
          id: d.id,
          rect: d.rect,
          deg: rotationDragDeg(d.frame0, d.grabDeg, pointer, e.shiftKey),
          deg0: d.frame0.deg,
        };
      }
      lastGesture.current = gesture;
      latest.current.onGesture(gesture);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [endDrag, snapLines]);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const id = el.dataset.gizmoId;
    const geometry = geomRef.current;
    const frame0 = id ? geometry?.frames[id] : undefined;
    if (!id || !geometry || !frame0) return;
    e.stopPropagation();
    latest.current.onSelect(id);
    const item = latest.current.items.find((x) => x.id === id);
    if (!item) return;
    const corner = HANDLES.find((h) => h.id === el.dataset.corner);
    const kind: Drag["kind"] = el.dataset.rotate ? "rotate" : corner ? "resize" : "move";
    if (kind === "move" && !item.can.move) return;
    if (kind === "resize" && !item.can.resize) return;
    if (kind === "rotate" && !item.can.rotate) return;
    el.setPointerCapture(e.pointerId);
    const basis = corner
      ? resizeBasis(frame0, corner.cx, corner.cy, latest.current.resizeAbout)
      : { fixed: frame0.pivot, diag: [0, 0] as Pt };
    lastGesture.current = null;
    drag.current = {
      kind,
      id,
      rect: geometry.rect,
      frame0,
      startX: e.clientX,
      startY: e.clientY,
      grabDeg: rotationDegAt(frame0.pivot, [e.clientX, e.clientY], false),
      fixedPx: basis.fixed,
      diagPx: basis.diag,
    };
    setDragKind(kind);
  }

  const overrideHeld = cameraOverrideHeld(mods);
  if (items.length === 0) return null;
  const rect = geom?.rect;
  // A drag in flight never changes owner, and with no camera tool armed a held ⌃ is the free-move modifier, not an override.
  const standDown = overrideHeld && cameraArmed && dragKind === null;

  return (
    <div
      ref={layerRef}
      className={gizmoLayerClass(standDown, dragKind === "rotate" ? "dragging-rotate" : undefined)}
    >
      {rect &&
        items.map((item) => {
          const frame = geom?.frames[item.id];
          if (!frame) return null;
          const selected = item.id === selectedId;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: a pointer drag + right-click surface over the canvas; keyboard editing is the inspector's fields
            <div
              key={item.id}
              data-gizmo-id={item.id}
              title={item.label}
              className={`gizmo-box ${GIZMO_HIT_CLASS}${selected ? " selected" : ""}`}
              style={{
                left: frame.cx - rect.left,
                top: frame.cy - rect.top,
                width: frame.w,
                height: frame.h,
                transform: `translate(-50%, -50%) rotate(${frame.deg}deg)`,
              }}
              onPointerDown={onPointerDown}
              onContextMenu={onContextMenu ? (e) => onContextMenu(item.id, e) : undefined}
            >
              {selected &&
                item.can.resize &&
                HANDLES.map((h) => (
                  <div
                    key={h.id}
                    data-gizmo-id={item.id}
                    data-corner={h.id}
                    className={`gizmo-handle ${GIZMO_HIT_CLASS}`}
                    style={{ left: h.left, top: h.top, cursor: h.cursor }}
                    onPointerDown={onPointerDown}
                  />
                ))}
              {selected && item.can.rotate && (
                <div
                  data-gizmo-id={item.id}
                  data-rotate="1"
                  className={`gizmo-rotate ${GIZMO_HIT_CLASS}`}
                  onPointerDown={onPointerDown}
                />
              )}
            </div>
          );
        })}
      {rect && guides.x !== null && (
        <div className="gizmo-guide v" style={{ left: guides.x - rect.left }} />
      )}
      {rect && guides.y !== null && (
        <div className="gizmo-guide h" style={{ top: guides.y - rect.top }} />
      )}
    </div>
  );
}
