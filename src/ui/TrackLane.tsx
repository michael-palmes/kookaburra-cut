import { useEffect, useRef, useState } from "react";
import { useClockStore } from "../engine/clock";
import { DEFAULT_EASE, EASE_FAMILIES } from "../engine/ease";
import { FPS } from "../engine/format";
import {
  addSegmentAt,
  type KeyedTrack,
  moveKey,
  moveSegment,
  nearestKey,
  playheadDriftTarget,
  removeKey,
  removeSegment,
  setSegmentEase,
  syncSegmentStartToPrevious,
  trackLayout,
} from "../engine/keyedTrack";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";

/** The generic keyed-track timeline lane, extracted verbatim from the camera AnimationLane so the layered-screenshot lane can reuse it: hard walls and gaps stay the model (the opposite of the video editor's magnetic reflow); the 4% minimum segment length is visual only (decision 16), drag clamps remain the engine's MIN_KEY_GAP_MS. Track-specific state (edit store, doc funnel, tool keys, copy) arrives through props from a thin wrapper. */

const PAD = 12; // px inset either side of the track
const SNAP_PX = 8; // playhead snap radius for diamond drags
const MOVE_THRESHOLD_PX = 4; // pointer travel before a press becomes a drag
const FRAME_MS = 1000 / FPS;
const MIN_SEGMENT_VISUAL = 0.04; // of the track's inner width, visual floor only

/** Round to the export frame grid, then to whole ms (sidecar times stay integers). */
function snapToFrame(ms: number): number {
  return Math.round(Math.round(ms / FRAME_MS) * FRAME_MS);
}

type DragState<T> =
  | { kind: "key"; id: string; startX: number; orig: T; moved: boolean }
  | {
      kind: "segment";
      docIndex: number;
      fromId: string;
      toId: string;
      startX: number;
      orig: T;
      moved: boolean;
    }
  // Background scrub: the playhead follows the pointer; selection follows the nearest key.
  | { kind: "scrub" };

export interface TrackLaneProps<P, T extends KeyedTrack<P>> {
  open: boolean;
  slotStartMs: number;
  durationMs: number;
  track: T;
  selectedKeyId: string | null;
  selectedSegment: number | null;
  writeError: string | null;
  select: (keyId: string | null, segment: number | null) => void;
  /** Event-time selection read (the store's getState), so the key handler never closes over stale props. */
  getSelection: () => { keyId: string | null; segment: number | null };
  /** Bare-key tool arming (the wrapper maps its own letters); return true when handled. */
  onToolKey: (key: string) => boolean;
  /** Esc: disarm the wrapper's tool if one is armed, else deselect. */
  onEscape: () => void;
  preview: (track: T, committed: boolean) => void;
  commit: (track: T) => void | Promise<void>;
  /** The applied pose at scene-local `t` (Add-animation's seeds, so adding never visibly moves anything). */
  poseAt: (localT: number) => P;
  onSceneDuration: (ms: number) => void;
  /** The ＋ Animation button's tooltip. */
  addTitle: string;
  /** Copy ahead of the write-error detail, e.g. "Save failed — this camera edit isn't on disk:". */
  writeErrorPrefix: string;
}

export function TrackLane<P, T extends KeyedTrack<P>>({
  open,
  slotStartMs,
  durationMs,
  track,
  selectedKeyId,
  selectedSegment,
  writeError,
  select,
  getSelection,
  onToolKey,
  onEscape,
  preview,
  commit,
  poseAt,
  onSceneDuration,
  addTitle,
  writeErrorPrefix,
}: TrackLaneProps<P, T>) {
  const currentMs = useClockStore((s) => s.currentMs);

  const trackRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);
  const [drag, setDrag] = useState<DragState<T> | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [durEdit, setDurEdit] = useState<string | null>(null);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    setTrackW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(0, trackW - PAD * 2);
  const pxPerMs = innerW > 0 ? innerW / durationMs : 0;
  const playheadLocal = Math.min(durationMs, Math.max(0, currentMs - slotStartMs));
  const layout = trackLayout(track);

  const xOf = (tMs: number) => PAD + Math.min(tMs, durationMs) * pxPerMs;

  /** Seek to the 25% point of the containing animation when the playhead sits mid-span, where an edit is hard to see. */
  function driftPlayhead() {
    const target = playheadDriftTarget(track, playheadLocal);
    if (target === null) return;
    const clock = useClockStore.getState();
    clock.setCurrentMs(Math.min(clock.durationMs, slotStartMs + target));
  }

  // Tool-arming, deselect/deletion/nudge keys, window-level so the lane needn't hold focus; the App frame-step handler stands down while a key is selected. Gated on `open` since the lane stays mounted through the collapse.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (document.querySelector(".modal-overlay")) return;
      if (e.key === "Escape") {
        onEscape();
        return;
      }
      // Bare letters arm the wrapper's tools (modifiers left alone: ⌘Z undo, ⌘P print…).
      if (!e.metaKey && !e.ctrlKey && !e.altKey && onToolKey(e.key.toLowerCase())) {
        e.preventDefault();
        return;
      }
      const selection = getSelection();
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && selection.keyId) {
        e.preventDefault();
        const key = track.keys.find((k) => k.id === selection.keyId);
        if (!key) return;
        const frames = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1);
        const next = moveKey(track, key.id, snapToFrame(key.tMs + frames * FRAME_MS), durationMs);
        if (next && next !== track) void commit(next);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // Instant delete by design: lane edits are rapid-fire, and the lane redraws immediately, so a slip is obvious and cheap to redo.
        if (selection.segment !== null) {
          const next = removeSegment(track, selection.segment);
          if (next) {
            select(null, null);
            void commit(next);
          }
        } else if (selection.keyId) {
          const next = removeKey(track, selection.keyId);
          if (next) {
            select(null, null);
            void commit(next);
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, track, commit, durationMs, select, getSelection, onToolKey, onEscape]);

  // ── Drags ─────────────────────────────────

  function onKeyPointerDown(e: React.PointerEvent, keyId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: "key", id: keyId, startX: e.clientX, orig: track, moved: false });
  }

  function onSegmentPointerDown(
    e: React.PointerEvent,
    docIndex: number,
    fromId: string,
    toId: string,
  ) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      kind: "segment",
      docIndex,
      fromId,
      toId,
      startX: e.clientX,
      orig: track,
      moved: false,
    });
  }

  /** Scrub to the pointer: seek the playhead (snapped to keys + scene edges), then select the nearest diamond so arrows/move tools target the key you scrubbed to. */
  function scrubAt(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || pxPerMs <= 0) return;
    let local = (clientX - rect.left - PAD) / pxPerMs;
    const snapRadius = SNAP_PX / pxPerMs;
    for (const target of [0, durationMs, ...track.keys.map((k) => Math.min(k.tMs, durationMs))]) {
      if (Math.abs(local - target) <= snapRadius) local = target;
    }
    local = Math.min(durationMs, Math.max(0, local));
    const clock = useClockStore.getState();
    clock.setCurrentMs(Math.min(clock.durationMs, slotStartMs + local));
    const near = nearestKey(track, local);
    if (near) select(near.id, null);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag || pxPerMs <= 0) return;
    if (drag.kind === "scrub") {
      scrubAt(e.clientX);
      return;
    }
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < MOVE_THRESHOLD_PX) return;
    if (!drag.moved) {
      setDrag({ ...drag, moved: true });
      driftPlayhead();
    }
    if (drag.kind === "key") {
      const origKey = drag.orig.keys.find((k) => k.id === drag.id);
      if (!origKey) return;
      let target = origKey.tMs + dx / pxPerMs;
      // Snap to the playhead within radius, then to the frame grid.
      const snapRadius = SNAP_PX / pxPerMs;
      if (Math.abs(target - playheadLocal) <= snapRadius) target = playheadLocal;
      const next = moveKey(drag.orig, drag.id, snapToFrame(target), durationMs);
      if (next) preview(next, false);
    } else {
      const next = moveSegment(
        drag.orig,
        drag.fromId,
        drag.toId,
        snapToFrame(dx / pxPerMs),
        durationMs,
      );
      if (next) preview(next, false);
    }
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.kind === "scrub") {
      setDrag(null);
      return;
    }
    if (drag.kind === "key") {
      if (drag.moved) {
        void commit(track);
      } else {
        // Click: select the diamond AND seek the playhead to it.
        select(drag.id, null);
        const key = track.keys.find((k) => k.id === drag.id);
        if (key) {
          const clock = useClockStore.getState();
          clock.setCurrentMs(
            Math.min(clock.durationMs, Math.max(0, slotStartMs + Math.min(key.tMs, durationMs))),
          );
        }
      }
    } else {
      if (drag.moved) void commit(track);
      else {
        select(null, drag.docIndex); // click: select block → easing popover
        driftPlayhead();
      }
    }
    setDrag(null);
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: "scrub" });
    scrubAt(e.clientX);
  }

  function onAddAnimation() {
    const start = snapToFrame(playheadLocal);
    const next = addSegmentAt(
      track,
      start,
      poseAt(start),
      poseAt(Math.min(start + 1000, durationMs)),
      durationMs,
    );
    if (next) void commit(next);
  }

  /** Right-click a segment: snap-to-previous plus instant delete (same as the Delete key). */
  function onSegmentContextMenu(e: React.MouseEvent, docIndex: number) {
    e.preventDefault();
    select(null, docIndex);
    const canSync = syncSegmentStartToPrevious(track, docIndex) !== null;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "sync-prev",
          label: "Snap start to previous animation",
          disabled: !canSync,
          title: canSync
            ? "Move this animation's first keyframe onto the previous animation's end"
            : "Already chained, or no animation before this one",
          onSelect: () => {
            const next = syncSegmentStartToPrevious(track, docIndex);
            if (next) void commit(next);
          },
        },
        {
          id: "delete",
          label: "Delete animation",
          danger: true,
          onSelect: () => {
            const next = removeSegment(track, docIndex);
            if (next) {
              select(null, null);
              void commit(next);
            }
          },
        },
      ],
    });
  }

  // What's in effect at the playhead: inside an animation both boundary keys glow and the bar tints; otherwise the single nearest diamond keeps the proximity emphasis.
  const activeSegment =
    layout.segments.find((s) => playheadLocal >= s.fromTMs && playheadLocal <= s.toTMs) ?? null;
  const nearIds = activeSegment
    ? [activeSegment.fromId, activeSegment.toId]
    : [nearestKey(track, playheadLocal)?.id ?? ""];

  const selectedSegmentLayout =
    selectedSegment !== null ? layout.segments.find((s) => s.docIndex === selectedSegment) : null;

  function finishDurationEdit(commitEdit: boolean) {
    const text = durEdit;
    setDurEdit(null);
    if (!commitEdit || text === null) return;
    const seconds = Number(text);
    // The playback bar's floor: junk and sub-100ms values are dropped silently.
    if (!Number.isFinite(seconds) || seconds < 0.1) return;
    const ms = Math.round(seconds * 1000);
    if (ms !== durationMs) onSceneDuration(ms);
  }

  return (
    <div className={`anim-lane${open ? " open" : ""}`} aria-hidden={!open}>
      <div className="anim-lane-row">
        <button
          type="button"
          className="btn primary btn-small"
          title={addTitle}
          onClick={onAddAnimation}
        >
          ＋ Animation
        </button>

        <div
          className="anim-track"
          ref={trackRef}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {layout.segments.map((seg) => {
            const left = xOf(seg.fromTMs);
            const width = Math.max(innerW * MIN_SEGMENT_VISUAL, xOf(seg.toTMs) - left);
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: pointer-driven editing surface — keyboard editing rides the window-level Delete/arrow handlers
              <div
                key={`${seg.fromId}-${seg.toId}`}
                className={`anim-seg${selectedSegment === seg.docIndex ? " selected" : ""}${
                  seg.ease === "jump" ? " jump" : ""
                }${activeSegment?.docIndex === seg.docIndex ? " at-playhead" : ""}`}
                style={{ left, width }}
                title={`Animation ${seg.ease === "jump" ? "(jump cut)" : `(${seg.ease})`} — drag to move, click for easing, right-click to delete`}
                onPointerDown={(e) => onSegmentPointerDown(e, seg.docIndex, seg.fromId, seg.toId)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={(e) => onSegmentContextMenu(e, seg.docIndex)}
              />
            );
          })}
          {layout.keys.map((key) => (
            <div
              key={key.id}
              className={`anim-key${selectedKeyId === key.id ? " selected" : ""}${
                nearIds.includes(key.id) ? " near" : ""
              }${key.tMs > durationMs ? " overhang" : ""}`}
              style={{ left: xOf(key.tMs) }}
              title={
                key.tMs > durationMs
                  ? `Keyframe at ${(key.tMs / 1000).toFixed(2)}s — past the scene end (holds clamp)`
                  : `Keyframe at ${(key.tMs / 1000).toFixed(2)}s — drag to retime, click to select + seek`
              }
              onPointerDown={(e) => onKeyPointerDown(e, key.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          ))}
          <span className="anim-playhead" style={{ left: xOf(playheadLocal) }} />
        </div>

        <span className="anim-readout">
          {`${(playheadLocal / 1000).toFixed(1).padStart(4, "0")} / `}
          {durEdit !== null ? (
            <input
              className="anim-duration-input"
              value={durEdit}
              // biome-ignore lint/a11y/noAutofocus: entered by double-clicking the readout, so it IS the focus target
              autoFocus
              aria-label="Scene length in seconds"
              onChange={(e) => setDurEdit(e.target.value)}
              onBlur={() => finishDurationEdit(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") finishDurationEdit(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="anim-duration"
              title="Scene length; double-click to type a new one"
              onDoubleClick={() => setDurEdit((durationMs / 1000).toFixed(2))}
            >
              {`${(durationMs / 1000).toFixed(1)}s`}
            </button>
          )}
        </span>
      </div>

      {writeError && (
        <div className="anim-lane-error" role="alert">
          {writeErrorPrefix} {writeError}
        </div>
      )}

      {selectedSegmentLayout && (
        <EasingPopover
          ease={selectedSegmentLayout.ease}
          onPick={(ease) => {
            const next = setSegmentEase(track, selectedSegmentLayout.docIndex, ease);
            if (next) void commit(next);
          }}
        />
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ── Easing popover ───────────────────────────────────

function EasingPopover({ ease, onPick }: { ease: string; onPick: (ease: string) => void }) {
  // Parse "inQuad"/"outSine"/"inOutBack" into direction + family for the grid state.
  const m = /^(in|out|inOut)([A-Z][a-z]+)$/.exec(ease);
  const family = m ? m[2] : "Quad";
  const chip = (value: string, label: string, extra = "") => (
    <button
      type="button"
      key={value + label}
      className={`chip${ease === value ? " selected" : ""}${extra}`}
      onClick={() => onPick(value)}
    >
      {label}
    </button>
  );
  return (
    <div className="camera-easing" role="menu" aria-label="Segment easing">
      <div className="camera-easing-row">
        {chip(DEFAULT_EASE, "Default")}
        {chip("linear", "Linear")}
        {chip(`in${family}`, "In")}
        {chip(`out${family}`, "Out")}
        {chip(`inOut${family}`, "In Out")}
        {chip("jump", "Jump cut")}
      </div>
      <div className="camera-easing-families">
        {EASE_FAMILIES.map((f) => {
          const dir = m ? m[1] : "inOut";
          return (
            <button
              type="button"
              key={f}
              className={`chip${family === f && m ? " selected" : ""}`}
              onClick={() => onPick(`${dir}${f}`)}
            >
              {f}
            </button>
          );
        })}
      </div>
    </div>
  );
}
