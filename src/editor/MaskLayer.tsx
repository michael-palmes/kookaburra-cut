import { useRef, useState } from "react";
import type { EditMask, EditSource } from "../engine/edit";
import {
  clampRect,
  defaultMaskRect,
  keyIndexAt,
  type MaskRect,
  maskActiveAt,
  rectFromCorners,
  sampleMaskRect,
} from "../engine/editMasks";
import { MaskEffect, type MaskMedia, rectStyle } from "./maskPreview";

/** The masks on the active source, drawn over its video box: each mask's effect, a hit area to select it, the selected box's 8 handles, and the armed draw surface. Every drag is one gesture with a 3 px threshold (a click never commits); a plain drag auto-keys at the frame on screen, ⌥ moves the whole path. */

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const DRAG_THRESHOLD_PX = 3;

export interface MaskLayerProps {
  source: EditSource;
  /** Masks on this source, in draw order. */
  masks: EditMask[];
  /** The source moment on screen, or null when none is (off the timeline). */
  sourceMs: number | null;
  /** Half an output frame in source ms: within it, a drag edits the key already there. */
  keyTolMs: number;
  selectedId: string | null;
  /** The draw tool is armed and the frame on screen can take a mask. */
  armed: boolean;
  /** Paused and not trim-scrubbing: boxes can be selected and dragged. */
  editable: boolean;
  media: MaskMedia | null;
  onSelect: (id: string | null) => void;
  /** A mask gesture started: playback pauses. */
  onGesture: () => void;
  onDraw: (rect: MaskRect) => void;
  onCommitRect: (id: string, rect: MaskRect, kind: "move" | "resize") => void;
  onCommitPath: (id: string, dx: number, dy: number) => void;
  onContextMenu: (id: string, clientX: number, clientY: number) => void;
}

interface Drag {
  id: string | null; // null = drawing a new box
  kind: "move" | "draw" | Handle;
  box: DOMRect;
  startClient: [number, number];
  start: [number, number];
  origin: MaskRect;
  path: boolean;
  moved: boolean;
}

function posIn(box: DOMRect, e: { clientX: number; clientY: number }): [number, number] {
  return [(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height];
}

function resizeRect(origin: MaskRect, handle: Handle, dx: number, dy: number): MaskRect {
  let [l, t] = [origin[0], origin[1]];
  let [r, b] = [origin[0] + origin[2], origin[1] + origin[3]];
  if (handle.includes("w")) l += dx;
  if (handle.includes("e")) r += dx;
  if (handle.includes("n")) t += dy;
  if (handle.includes("s")) b += dy;
  return rectFromCorners([l, t], [r, b]);
}

export function MaskLayer({
  source,
  masks,
  sourceMs,
  keyTolMs,
  selectedId,
  armed,
  editable,
  media,
  onSelect,
  onGesture,
  onDraw,
  onCommitRect,
  onCommitPath,
  onContextMenu,
}: MaskLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<{ id: string | null; rect: MaskRect } | null>(null);
  const image = source.kind === "image";

  const begin = (
    e: React.PointerEvent,
    id: string | null,
    kind: Drag["kind"],
    origin: MaskRect,
  ) => {
    if (e.button !== 0 || !layerRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    onGesture();
    if (id) onSelect(id);
    const box = layerRef.current.getBoundingClientRect();
    dragRef.current = {
      id,
      kind,
      box,
      startClient: [e.clientX, e.clientY],
      start: posIn(box, e),
      origin,
      path: kind === "move" && e.altKey && !image,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const dragRect = (drag: Drag, e: { clientX: number; clientY: number }): MaskRect => {
    const p = posIn(drag.box, e);
    const [dx, dy] = [p[0] - drag.start[0], p[1] - drag.start[1]];
    if (drag.kind === "draw") return rectFromCorners(drag.start, p);
    if (drag.kind === "move") {
      return clampRect([drag.origin[0] + dx, drag.origin[1] + dy, drag.origin[2], drag.origin[3]]);
    }
    return resizeRect(drag.origin, drag.kind, dx, dy);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved) {
      const d = Math.hypot(e.clientX - drag.startClient[0], e.clientY - drag.startClient[1]);
      if (d < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    setDraft({ id: drag.id, rect: dragRect(drag, e) });
  };

  const finish = (e: React.PointerEvent, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDraft(null);
    if (!commit) return;
    if (drag.kind === "draw") {
      onDraw(drag.moved ? dragRect(drag, e) : defaultMaskRect(drag.start, source));
      return;
    }
    if (!drag.moved || !drag.id) return;
    const rect = dragRect(drag, e);
    if (drag.path) {
      onCommitPath(drag.id, rect[0] - drag.origin[0], rect[1] - drag.origin[1]);
    } else {
      onCommitRect(drag.id, rect, drag.kind === "move" ? "move" : "resize");
    }
  };

  const shown = sourceMs === null ? [] : masks;
  return (
    <div
      ref={layerRef}
      className="mask-layer"
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
    >
      {shown.map((mask) => {
        const at = sourceMs ?? 0;
        const active = maskActiveAt(mask, at, image);
        const sampled = sampleMaskRect(mask.keys, image ? 0 : at);
        if (!sampled) return null;
        const rect = draft && draft.id === mask.id ? draft.rect : sampled;
        const selected = mask.id === selectedId;
        if (!active) {
          return selected ? (
            <div
              key={mask.id}
              className="mask-frame inactive"
              style={rectStyle(sampled)}
              title="This mask is off at this frame: move the playhead into its span to edit it"
            />
          ) : null;
        }
        const onKey = image || keyIndexAt(mask.keys, at, keyTolMs) >= 0;
        return (
          <div key={mask.id} className="mask-item">
            <MaskEffect mask={mask} rect={rect} source={source} media={media} />
            {editable && (
              // biome-ignore lint/a11y/noStaticElementInteractions: a draggable box; the strip and ⌫ cover keyboard use
              <div
                className={`mask-frame${selected ? " selected" : ""}`}
                style={rectStyle(rect)}
                title={
                  selected
                    ? "Drag to move (keys this frame), ⌥-drag to move the whole path; right-click for options"
                    : "Mask: click to select"
                }
                onPointerDown={(e) => begin(e, mask.id, "move", sampled)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(mask.id);
                  onContextMenu(mask.id, e.clientX, e.clientY);
                }}
              >
                {selected && (
                  <>
                    <span
                      className={`mask-key-badge${onKey ? " on" : ""}`}
                      title={
                        onKey
                          ? "A key sits at this frame: dragging edits it"
                          : "No key at this frame: dragging adds one"
                      }
                    />
                    {HANDLES.map((h) => (
                      <span
                        key={h}
                        className={`mask-handle ${h}`}
                        onPointerDown={(e) => begin(e, mask.id, h, sampled)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {armed && (
        <div
          className="mask-draw-layer"
          onPointerDown={(e) => begin(e, null, "draw", [0, 0, 0, 0])}
        />
      )}
      {draft && draft.id === null && <div className="mask-draft" style={rectStyle(draft.rect)} />}
    </div>
  );
}
