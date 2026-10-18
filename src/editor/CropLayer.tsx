import { type CSSProperties, useRef, useState } from "react";
import type { EditSource } from "../engine/edit";
import { type CropRect, cropPixels, MIN_CROP_SIZE } from "../engine/editMath";
import { rectStyle } from "./maskPreview";
import { ToolIcon } from "./ToolIcon";

/** The crop tool over the clip on screen, drawn on its whole source frame: the crop box with the outside dimmed, corner handles locked to the output's shape, a drag inside moves it and a drag outside draws a new one. Chrome only: the render cuts the crop in ffmpeg (edit.rs) and the paused preview shows the result through CSS on the video box (`cropViewStyle`). */

type Corner = "nw" | "ne" | "se" | "sw";
const CORNERS: Corner[] = ["nw", "ne", "se", "sw"];
const DRAG_THRESHOLD_PX = 3;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The crop box's width over its height in normalised source units, for an output `aspect` (pixels). */
export function normalisedAspect(source: Pick<EditSource, "width" | "height">, aspect: number) {
  return source.width > 0 && source.height > 0 ? (aspect * source.height) / source.width : 1;
}

/** The box from `anchor` toward `pointer` at normalised aspect `k`, as large as the pointer reaches and the frame allows. */
export function aspectBox(
  anchor: [number, number],
  pointer: [number, number],
  k: number,
): CropRect {
  const sx = pointer[0] >= anchor[0] ? 1 : -1;
  const sy = pointer[1] >= anchor[1] ? 1 : -1;
  const roomW = sx > 0 ? 1 - anchor[0] : anchor[0];
  const roomH = sy > 0 ? 1 - anchor[1] : anchor[1];
  let w = Math.max(Math.abs(pointer[0] - anchor[0]), Math.abs(pointer[1] - anchor[1]) * k);
  let h = w / k;
  if (w > roomW) [w, h] = [roomW, roomW / k];
  if (h > roomH) [w, h] = [roomH * k, roomH];
  return [sx > 0 ? anchor[0] : anchor[0] - w, sy > 0 ? anchor[1] : anchor[1] - h, w, h];
}

/** A box moved by `(dx, dy)` and kept inside the frame. */
export function movedBox(box: CropRect, dx: number, dy: number): CropRect {
  return [clamp(box[0] + dx, 0, 1 - box[2]), clamp(box[1] + dy, 0, 1 - box[3]), box[2], box[3]];
}

const opposite = (box: CropRect, corner: Corner): [number, number] => [
  corner.includes("w") ? box[0] + box[2] : box[0],
  corner.includes("n") ? box[1] + box[3] : box[1],
];

/** CSS on the source box that shows only `crop`, scaled to fit the preview area and centred in it; `--crop-k` lets handles and markers keep their size. */
export function cropViewStyle(
  crop: CropRect,
  source: Pick<EditSource, "width" | "height">,
  area: { width: number; height: number },
): CSSProperties | undefined {
  const { width: W, height: H } = source;
  if (W <= 0 || H <= 0 || area.width <= 0 || area.height <= 0) return undefined;
  const [x, y, w, h] = cropPixels(crop, source).map((v, i) => v / (i % 2 === 0 ? W : H));
  const boxW = Math.min(area.width, (area.height * W) / H);
  const boxH = Math.min(area.height, (area.width * H) / W);
  const k = Math.min(area.width / (w * boxW), area.height / (h * boxH));
  const tx = (area.width - k * w * boxW) / 2 - (area.width - boxW) / 2 - k * x * boxW;
  const ty = (area.height - k * h * boxH) / 2 - (area.height - boxH) / 2 - k * y * boxH;
  const pct = (v: number) => `${v * 100}%`;
  return {
    transformOrigin: "0 0",
    transform: `translate(${tx}px, ${ty}px) scale(${k})`,
    clipPath: `inset(${pct(y)} ${pct(1 - x - w)} ${pct(1 - y - h)} ${pct(x)})`,
    "--crop-k": k,
  } as CSSProperties;
}

interface Drag {
  kind: "draw" | "move" | Corner;
  box: DOMRect;
  startClient: [number, number];
  start: [number, number];
  origin: CropRect | null;
  moved: boolean;
}

export interface CropLayerProps {
  source: EditSource;
  /** The clip's crop; null = the whole frame. */
  crop: CropRect | null;
  /** The output's width over its height: every box keeps it. */
  aspect: number;
  /** Paused and not trim-scrubbing: the box can be dragged. */
  editable: boolean;
  onGesture: () => void;
  onCommit: (rect: CropRect) => void;
}

export function CropLayer({ source, crop, aspect, editable, onGesture, onCommit }: CropLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<CropRect | null>(null);
  const k = normalisedAspect(source, aspect);

  const posIn = (box: DOMRect, e: { clientX: number; clientY: number }): [number, number] => [
    clamp((e.clientX - box.left) / box.width, 0, 1),
    clamp((e.clientY - box.top) / box.height, 0, 1),
  ];

  const begin = (e: React.PointerEvent, kind: Drag["kind"]) => {
    if (!editable || e.button !== 0 || !layerRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    onGesture();
    const box = layerRef.current.getBoundingClientRect();
    dragRef.current = {
      kind,
      box,
      startClient: [e.clientX, e.clientY],
      start: posIn(box, e),
      origin: crop,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const dragBox = (drag: Drag, e: { clientX: number; clientY: number }): CropRect => {
    const p = posIn(drag.box, e);
    const { kind, origin } = drag;
    if (kind === "draw" || !origin) return aspectBox(drag.start, p, k);
    if (kind === "move") return movedBox(origin, p[0] - drag.start[0], p[1] - drag.start[1]);
    return aspectBox(opposite(origin, kind), p, k);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved) {
      const d = Math.hypot(e.clientX - drag.startClient[0], e.clientY - drag.startClient[1]);
      if (d < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    setDraft(dragBox(drag, e));
  };

  const finish = (e: React.PointerEvent, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDraft(null);
    if (!commit || !drag.moved) return;
    const box = dragBox(drag, e);
    if (box[2] >= MIN_CROP_SIZE && box[3] >= MIN_CROP_SIZE) onCommit(box);
  };

  const shown = draft ?? crop;
  return (
    <div
      ref={layerRef}
      className={`crop-layer${editable ? "" : " locked"}`}
      onPointerDown={(e) => begin(e, "draw")}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
    >
      {shown && (
        <div
          className="crop-box"
          style={rectStyle(shown)}
          title="Drag to move the crop; drag a corner to resize it at the output's shape"
          onPointerDown={(e) => begin(e, "move")}
        >
          {CORNERS.map((c) => (
            <span key={c} className={`crop-handle ${c}`} onPointerDown={(e) => begin(e, c)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The crop strip under the topbar (the mask strip's pattern) while the crop tool is armed: fit the output's shape, reset, and how to draw. */
export function CropSettingsBar({
  clipId,
  hasCrop,
  onFit,
  onReset,
}: {
  /** The clip on screen, or null when the playhead is off every clip. */
  clipId: string | null;
  hasCrop: boolean;
  onFit: () => void;
  onReset: () => void;
}) {
  return (
    <div className="tap-settings mask-settings crop-settings">
      <span className="mask-settings-hint">
        {clipId
          ? `Drag over the preview to crop ${clipId} to the output's shape.`
          : "Move the playhead onto a clip to crop it."}
      </span>
      <button
        type="button"
        className="tap-settings-style-btn"
        disabled={!clipId}
        title="Crop to the largest centred box at the output's shape"
        onClick={onFit}
      >
        <ToolIcon id="fitCrop" />
        Fit output
      </button>
      <button
        type="button"
        className="tap-settings-style-btn"
        disabled={!clipId || !hasCrop}
        title={hasCrop ? "Show this clip's whole frame again" : "This clip isn't cropped"}
        onClick={onReset}
      >
        <ToolIcon id="resetCrop" />
        Reset
      </button>
    </div>
  );
}
