import { useEffect, useRef, useState } from "react";
import type { EditClip, EditSource, EditTap } from "../engine/edit";
import {
  clipIndexAt,
  clipTimelineMs,
  edgeTargetsMs,
  moveClip,
  setClipHold,
  snapMs,
  timelineDurationMs,
  trimClipIn,
  trimClipOut,
} from "../engine/editMath";
import { fsUrl, MEDIA_DRAG_TYPE, type MediaMeta } from "../engine/media";
import type { TrimScrub } from "./Preview";

/** The magnetic timeline: seconds ruler + playhead, filmstrip clip blocks with trim handles, drag-reorder, zoom (fit-all default), edge/playhead snapping. Clips always butt together (gapless, a locked decision); every interaction commits a relaid clips array via `onCommit`, which the editor autosaves. Here the playhead is the edit cursor (split point, snap target). */

export interface TimelineProps {
  clips: EditClip[]; // relaid (magnetic), array order is timeline order
  sources: EditSource[];
  metas: Record<string, MediaMeta | null>; // by source id, filmstrip frames (scrub cache)
  selectedId: string | null;
  playheadMs: number;
  onSelect: (id: string | null) => void;
  onPlayhead: (ms: number) => void;
  onCommit: (clips: EditClip[]) => void;
  /** Live trim feedback: the dragged edge's source frame, null when the drag ends. */
  onTrimScrub?: (scrub: TrimScrub | null) => void;
  /** Horizontal wheel/trackpad delta scrubs the playhead (scroll scrubs in both the preview and the timeline; the timeline pans via auto-follow). */
  onScrubWheel?: (deltaPx: number) => void;
  /** A media-panel card was dropped here: splice `rel` in at output time `tMs` (mid-clip splits the clip under it; edge-snapped). */
  onDropClipAt?: (rel: string, tMs: number) => void;
  /** Right-click on a clip block: the host opens its shared ContextMenu at (x, y). */
  onClipMenu?: (id: string, x: number, y: number) => void;
  /** Tap highlights' output windows; each gets a ruler dot that seeks to it. */
  tapWindowList?: { tap: EditTap; startMs: number; endMs: number }[];
  /** The reference edit's clips (relaid), drawn as a slim read-only lane under the track at the same scale so cuts can be matched by sight. */
  referenceClips?: EditClip[];
  /** The reference pane's provisional offset in output ms; shifts the lane with the nudge. */
  referenceOffsetMs?: number;
}

const PAD_L = 16; // content inset before t=0
const TAIL_PX = 96; // breathing room after the last clip
const SNAP_PX = 8; // snap radius, in screen px (converted to ms at the current zoom)
const MOVE_THRESHOLD_PX = 4; // pointer travel before a click becomes a reorder-drag
const MIN_PX_PER_MS = 0.005;
const MAX_PX_PER_MS = 4;

type DragState =
  | {
      kind: "trim-in" | "trim-out" | "hold";
      id: string;
      startClientX: number;
      orig: EditClip[];
      draft: EditClip[];
    }
  | {
      kind: "move";
      id: string;
      fromIndex: number;
      toIndex: number;
      startClientX: number;
      pointerDx: number;
      active: boolean;
      orig: EditClip[];
    };

interface Block {
  clip: EditClip;
  x: number;
  w: number;
  dragging: boolean;
}

function clampZoom(pxPerMs: number): number {
  return Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, pxPerMs));
}

function tickStepMs(pxPerMs: number): number {
  const TARGET_PX = 80;
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000];
  return steps.find((s) => s * pxPerMs >= TARGET_PX) ?? 60000;
}

function tickLabel(ms: number): string {
  const s = ms / 1000;
  if (s >= 60) {
    return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  }
  return `${Number(s.toFixed(2))}s`;
}

function effectiveSpeed(speed: number): number {
  return speed > 0 ? speed : 1;
}

export function Timeline({
  clips,
  sources,
  metas,
  selectedId,
  playheadMs,
  onSelect,
  onPlayhead,
  onCommit,
  onTrimScrub,
  onScrubWheel,
  onDropClipAt,
  onClipMenu,
  tapWindowList,
  referenceClips,
  referenceOffsetMs = 0,
}: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null); // null = fit-all (the default)
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropMs, setDropMs] = useState<number | null>(null); // media-panel drops (output ms)

  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const durationMs = timelineDurationMs(clips);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Wheel scrubs the playhead (native non-passive listener; React's onWheel can't reliably preventDefault the scroller's own pan).
  const onScrubWheelRef = useRef(onScrubWheel);
  onScrubWheelRef.current = onScrubWheel;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!onScrubWheelRef.current) return;
      const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      onScrubWheelRef.current(delta);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const fitPx =
    viewW > 0 && durationMs > 0 ? clampZoom((viewW - PAD_L - TAIL_PX) / durationMs) : 0.25;
  const pxPerMs = zoom ?? fitPx;
  const snapThresholdMs = SNAP_PX / pxPerMs;

  // Auto-follow: wheel-panning now scrubs instead, so keep the playhead in view when zoomed (the scrollbar still pans manually).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const x = PAD_L + playheadMs * pxPerMs;
    const margin = 32;
    if (x < el.scrollLeft + margin || x > el.scrollLeft + el.clientWidth - margin) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
    }
  }, [playheadMs, pxPerMs]);

  /** Timeline ms under a pointer event (content-relative, unclamped). */
  function pointerMs(clientX: number): number {
    const rect = contentRef.current?.getBoundingClientRect();
    return rect ? (clientX - rect.left - PAD_L) / pxPerMs : 0;
  }

  // ── Block layout (the one place drag visuals are decided) ────────────────
  function computeBlocks(): Block[] {
    if (!drag) {
      return clips.map((clip) => ({
        clip,
        x: clip.startMs * pxPerMs,
        w: clipTimelineMs(clip) * pxPerMs,
        dragging: false,
      }));
    }
    if (drag.kind === "move") {
      // Reorder: the dragged block follows the pointer; the rest reflow live around the gap at the current insertion index.
      const draggedOrig = drag.orig[drag.fromIndex];
      const draggedDur = clipTimelineMs(draggedOrig);
      const others = drag.orig.filter((c) => c.id !== drag.id);
      const blocks: Block[] = [];
      let t = 0;
      for (let slot = 0; slot < others.length; slot++) {
        if (slot === drag.toIndex) t += draggedDur;
        blocks.push({
          clip: others[slot],
          x: t * pxPerMs,
          w: clipTimelineMs(others[slot]) * pxPerMs,
          dragging: false,
        });
        t += clipTimelineMs(others[slot]);
      }
      blocks.push({
        clip: draggedOrig,
        x: draggedOrig.startMs * pxPerMs + drag.pointerDx,
        w: draggedDur * pxPerMs,
        dragging: true,
      });
      return blocks;
    }
    // Trim: freeze every committed position; the trimmed block anchors its far edge (right for trim-in, left for trim-out). Downstream closes up on commit (the CSS left/width transition animates the magnetic close).
    const trim = drag;
    return trim.orig.map((origClip) => {
      const draftClip = trim.draft.find((c) => c.id === origClip.id) ?? origClip;
      const w = clipTimelineMs(draftClip) * pxPerMs;
      const origX = origClip.startMs * pxPerMs;
      const origW = clipTimelineMs(origClip) * pxPerMs;
      const x = trim.kind === "trim-in" && origClip.id === trim.id ? origX + origW - w : origX;
      return { clip: draftClip, x, w, dragging: origClip.id === trim.id };
    });
  }

  const blockById = new Map(computeBlocks().map((b) => [b.clip.id, b]));
  // Render over a STABLE array so pointer capture survives the drag (no DOM reorders).
  const renderClips = drag ? drag.orig : clips;

  // ── Trim ──────────────────────────────────────────────────────────────────
  /** The dragged edge's source frame (feeds the viewer while trimming). */
  function trimScrubOf(draft: EditClip[], id: string, kind: "trim-in" | "trim-out") {
    const clip = draft.find((c) => c.id === id);
    if (!clip) return null;
    return {
      sourceId: clip.sourceId,
      sourceMs: kind === "trim-in" ? clip.inMs : clip.outMs,
      edge: kind === "trim-in" ? ("in" as const) : ("out" as const),
    };
  }

  function onTrimPointerDown(
    e: React.PointerEvent,
    id: string,
    kind: "trim-in" | "trim-out" | "hold",
  ) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect(id);
    setDrag({ kind, id, startClientX: e.clientX, orig: clips, draft: clips });
    // A hold drag never changes the pinned frame, so there is nothing to scrub.
    if (kind !== "hold") onTrimScrub?.(trimScrubOf(clips, id, kind));
  }

  function onTrimPointerMove(e: React.PointerEvent) {
    if (!drag || drag.kind === "move") return;
    const origClip = drag.orig.find((c) => c.id === drag.id);
    if (!origClip) return;
    const dxMs = (e.clientX - drag.startClientX) / pxPerMs;
    const speed = effectiveSpeed(origClip.speed);
    const startTl = origClip.startMs;
    const endTl = startTl + clipTimelineMs(origClip);
    let draft: EditClip[];
    if (drag.kind === "hold") {
      const edgeTl = snapMs(endTl + dxMs, [playheadMs], snapThresholdMs);
      draft = setClipHold(drag.orig, drag.id, edgeTl - startTl);
    } else if (drag.kind === "trim-in") {
      const edgeTl = snapMs(startTl + dxMs, [playheadMs], snapThresholdMs);
      draft = trimClipIn(drag.orig, drag.id, origClip.outMs - (endTl - edgeTl) * speed);
    } else {
      const source = sourceById.get(origClip.sourceId);
      const edgeTl = snapMs(endTl + dxMs, [playheadMs], snapThresholdMs);
      draft = trimClipOut(
        drag.orig,
        drag.id,
        origClip.inMs + (edgeTl - startTl) * speed,
        source?.durationMs ?? origClip.outMs,
      );
    }
    setDrag({ ...drag, draft });
    if (drag.kind !== "hold") onTrimScrub?.(trimScrubOf(draft, drag.id, drag.kind));
  }

  function onTrimPointerUp() {
    if (!drag || drag.kind === "move") return;
    const orig = drag.orig.find((c) => c.id === drag.id);
    const draft = drag.draft.find((c) => c.id === drag.id);
    if (
      orig &&
      draft &&
      (orig.inMs !== draft.inMs || orig.outMs !== draft.outMs || orig.holdMs !== draft.holdMs)
    ) {
      onCommit(drag.draft);
    }
    setDrag(null);
    onTrimScrub?.(null);
  }

  // ── Reorder ───────────────────────────────────────────────────────────────
  function onClipPointerDown(e: React.PointerEvent, id: string) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect(id);
    const fromIndex = clips.findIndex((c) => c.id === id);
    if (fromIndex < 0) return;
    setDrag({
      kind: "move",
      id,
      fromIndex,
      toIndex: fromIndex,
      startClientX: e.clientX,
      pointerDx: 0,
      active: false,
      orig: clips,
    });
  }

  function onClipPointerMove(e: React.PointerEvent) {
    if (drag?.kind !== "move") return;
    const dx = e.clientX - drag.startClientX;
    const active = drag.active || Math.abs(dx) > MOVE_THRESHOLD_PX;
    if (!active) return;
    const draggedOrig = drag.orig[drag.fromIndex];
    const centerPx =
      draggedOrig.startMs * pxPerMs + dx + (clipTimelineMs(draggedOrig) * pxPerMs) / 2;
    const others = drag.orig.filter((c) => c.id !== drag.id);
    let cum = 0;
    let toIndex = 0;
    for (const c of others) {
      const w = clipTimelineMs(c) * pxPerMs;
      if (centerPx > cum + w / 2) toIndex++;
      cum += w;
    }
    setDrag({ ...drag, pointerDx: dx, active, toIndex });
  }

  function onClipPointerUp() {
    if (drag?.kind !== "move") return;
    if (drag.active && drag.toIndex !== drag.fromIndex) {
      onCommit(moveClip(drag.orig, drag.fromIndex, drag.toIndex));
    }
    setDrag(null);
  }

  /** Abandon any drag (pointercancel): discard the draft and clear the viewer override. */
  function cancelDrag() {
    setDrag(null);
    onTrimScrub?.(null);
  }

  // ── Media-panel drops (HTML5 DnD; editor window only) ────────────────────
  /** Drop time at clientX: edge-snapped and floored at 0 (past the end the splice appends). A point inside a freeze resolves to the freeze's nearer edge here, so the indicator shows where insertClipAt will actually land. */
  function dropMsAt(clientX: number): number {
    const raw = Math.max(0, pointerMs(clientX));
    const snapped = Math.round(snapMs(raw, edgeTargetsMs(clips), snapThresholdMs));
    const i = clipIndexAt(clips, snapped);
    const under = i >= 0 ? clips[i] : undefined;
    if (under && under.holdMs !== undefined) {
      const before = snapped - under.startMs < clipTimelineMs(under) / 2;
      return before ? under.startMs : under.startMs + Math.round(clipTimelineMs(under));
    }
    return snapped;
  }

  function onMediaDragOver(e: React.DragEvent) {
    if (!onDropClipAt || !e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropMs(dropMsAt(e.clientX));
  }

  function onMediaDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return; // still inside
    setDropMs(null);
  }

  function onMediaDrop(e: React.DragEvent) {
    setDropMs(null);
    if (!onDropClipAt) return;
    const rel = e.dataTransfer.getData(MEDIA_DRAG_TYPE) || e.dataTransfer.getData("text/plain");
    if (!rel) return;
    e.preventDefault();
    onDropClipAt(rel, dropMsAt(e.clientX));
  }

  // ── Playhead (ruler scrub with edge snapping) ─────────────────────────────
  function seekTo(clientX: number) {
    const raw = Math.max(0, Math.min(durationMs, pointerMs(clientX)));
    onPlayhead(Math.round(snapMs(raw, edgeTargetsMs(clips), snapThresholdMs)));
  }

  function onRulerPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  }

  function onRulerPointerMove(e: React.PointerEvent) {
    if (e.buttons & 1) seekTo(e.clientX);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const contentW = PAD_L + durationMs * pxPerMs + TAIL_PX;
  const step = tickStepMs(pxPerMs);
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs + TAIL_PX / pxPerMs; t += step / 2) ticks.push(t);
  const playheadX = PAD_L + playheadMs * pxPerMs;

  return (
    <div className="timeline">
      <div className="timeline-zoom">
        <button
          type="button"
          className="btn"
          title="Zoom out"
          onClick={() => setZoom(clampZoom(pxPerMs / 1.5))}
        >
          −
        </button>
        <button
          type="button"
          className="btn"
          title="Fit the whole timeline"
          onClick={() => setZoom(null)}
        >
          Fit
        </button>
        <button
          type="button"
          className="btn"
          title="Zoom in"
          onClick={() => setZoom(clampZoom(pxPerMs * 1.5))}
        >
          +
        </button>
      </div>
      <div className="timeline-scroller" ref={scrollerRef}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drop target only — pointer-free hosts add clips via the media modal's buttons */}
        <div
          className="timeline-content"
          ref={contentRef}
          style={{ width: contentW }}
          onDragOver={onMediaDragOver}
          onDragLeave={onMediaDragLeave}
          onDrop={onMediaDrop}
        >
          <div
            className="timeline-ruler"
            onPointerDown={onRulerPointerDown}
            onPointerMove={onRulerPointerMove}
          >
            {ticks.map((t, i) => (
              <div
                key={t}
                className={i % 2 === 0 ? "timeline-tick" : "timeline-tick minor"}
                style={{ left: PAD_L + t * pxPerMs }}
              >
                {i % 2 === 0 && <span className="timeline-tick-label">{tickLabel(t)}</span>}
              </div>
            ))}
            {tapWindowList?.map(({ tap, startMs }) => (
              <button
                key={`${tap.id}:${startMs}`}
                type="button"
                className="timeline-tap-dot"
                style={{ left: PAD_L + startMs * pxPerMs }}
                title="Tap highlight: jump the playhead here"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onPlayhead(startMs)}
              />
            ))}
          </div>
          <div className="timeline-track" onPointerDown={() => onSelect(null)}>
            {renderClips.length === 0 && (
              <span className="timeline-empty muted">No clips: everything was deleted.</span>
            )}
            {renderClips.map((stable) => {
              const block = blockById.get(stable.id);
              if (!block) return null;
              const { clip } = block;
              const source = sourceById.get(clip.sourceId);
              const meta = metas[clip.sourceId] ?? null;
              const speed = effectiveSpeed(clip.speed);
              const name = (source?.rel ?? clip.sourceId).replace(/^assets\//, "");
              const frozen = clip.holdMs !== undefined;
              return (
                // biome-ignore lint/a11y/useSemanticElements: a real <button> won't paint img children in WKWebView
                <div
                  key={stable.id}
                  role="button"
                  tabIndex={0}
                  className={`timeline-clip${clip.id === selectedId ? " selected" : ""}${block.dragging ? " dragging" : ""}${frozen ? " frozen" : ""}`}
                  style={{ left: PAD_L + block.x, width: Math.max(4, block.w) }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onClipPointerDown(e, clip.id);
                  }}
                  onPointerMove={onClipPointerMove}
                  onPointerUp={onClipPointerUp}
                  onPointerCancel={cancelDrag}
                  onContextMenu={
                    onClipMenu
                      ? (e) => {
                          e.preventDefault();
                          onSelect(clip.id);
                          onClipMenu(clip.id, e.clientX, e.clientY);
                        }
                      : undefined
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(clip.id);
                    }
                  }}
                >
                  {meta && !frozen && meta.scrubPaths.length > 0 && source && (
                    <div
                      className="timeline-film"
                      aria-hidden
                      style={{
                        left: -((clip.inMs / speed) * pxPerMs),
                        width: (source.durationMs / speed) * pxPerMs,
                      }}
                    >
                      {meta.scrubPaths.map((p) => (
                        <img key={p} src={fsUrl(p)} alt="" draggable={false} />
                      ))}
                    </div>
                  )}
                  <span className="timeline-clip-label">
                    {frozen ? `❄ ${name}` : name}
                    {!frozen && speed !== 1 ? ` · ${Number(speed.toFixed(2))}×` : ""}
                  </span>
                  {frozen ? (
                    // A freeze has no in-point: one right-edge handle retimes the hold.
                    <div
                      className="timeline-handle right"
                      title="Drag to retime the freeze"
                      onPointerDown={(e) => onTrimPointerDown(e, clip.id, "hold")}
                      onPointerMove={onTrimPointerMove}
                      onPointerUp={onTrimPointerUp}
                      onPointerCancel={cancelDrag}
                    />
                  ) : (
                    <>
                      <div
                        className="timeline-handle left"
                        onPointerDown={(e) => onTrimPointerDown(e, clip.id, "trim-in")}
                        onPointerMove={onTrimPointerMove}
                        onPointerUp={onTrimPointerUp}
                        onPointerCancel={cancelDrag}
                      />
                      <div
                        className="timeline-handle right"
                        onPointerDown={(e) => onTrimPointerDown(e, clip.id, "trim-out")}
                        onPointerMove={onTrimPointerMove}
                        onPointerUp={onTrimPointerUp}
                        onPointerCancel={cancelDrag}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {referenceClips && referenceClips.length > 0 && (
            <div className="timeline-ref-lane" title="Reference clips, read-only">
              {referenceClips.map((clip) => (
                <div
                  key={clip.id}
                  className="timeline-ref-clip"
                  style={{
                    left: PAD_L + (clip.startMs - referenceOffsetMs) * pxPerMs,
                    width: Math.max(
                      2,
                      (clip.holdMs ?? (clip.outMs - clip.inMs) / effectiveSpeed(clip.speed)) *
                        pxPerMs,
                    ),
                  }}
                />
              ))}
            </div>
          )}
          {dropMs !== null && (
            <div
              className="timeline-drop-indicator"
              style={{ left: PAD_L + Math.min(dropMs, durationMs) * pxPerMs }}
            />
          )}
          <div className="timeline-playhead" style={{ left: playheadX }}>
            <div className="timeline-playhead-cap" />
          </div>
        </div>
      </div>
    </div>
  );
}
