import { useEffect, useRef, useState } from "react";
import { useClockStore } from "../engine/clock";
import { DEFAULT_EASE, EASE_FAMILIES, ease } from "../engine/ease";
import { FPS } from "../engine/format";
import {
  addAnimationAuto,
  addedKey,
  deleteKeyMerged,
  duplicateKey,
  duplicateKeyBefore,
  junctionInfo,
  type KeyedTrack,
  type KeyedTrackKey,
  type MergedDelete,
  MIN_KEY_GAP_MS,
  mergeGap,
  moveKey,
  moveSegment,
  nearestKey,
  nextKeyId,
  playheadDriftTarget,
  removeSegment,
  resizeBounds,
  resizeSegment,
  type SegmentEaseChannel,
  setSegmentEase,
  splitSegmentAt,
  type TrackContext,
  type TrackLayout,
  trackLayout,
} from "../engine/keyedTrack";
import { useUiStore } from "../store/uiStore";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { formatSceneLengthMs, parseSceneLengthMs } from "./durationText";
import { ToggleRow } from "./inspector/rows";
import { seekSceneLocal } from "./laneSeek";
import { ResizeAnimationModal } from "./ResizeAnimationModal";
import { commitFocusedInspectorEdit } from "./textEditFocus";

/** The generic keyed-track timeline lane, extracted verbatim from the camera AnimationLane so the layered-screenshot lane can reuse it: hard walls and gaps stay the model (the opposite of the video editor's magnetic reflow); the 4% minimum segment length is visual only (decision 16). Animations are CONNECTED: one diamond per key, so a shared junction is ONE handle, keys attached to no segment draw nothing, and the pixel-derived `minLenMs` (24px, 10px in the Detailed view) rather than MIN_KEY_GAP_MS is what drags and the connected engine ops clamp against. Track-specific state (edit store, doc funnel, tool keys, copy) arrives through props from a thin wrapper. */

const PAD = 12; // px inset either side of the track
const SNAP_PX = 8; // playhead snap radius for diamond drags
const MOVE_THRESHOLD_PX = 4; // pointer travel before a press becomes a drag
const FRAME_MS = 1000 / FPS;
const MIN_SEGMENT_VISUAL = 0.04; // of the track's inner width, visual floor only
/** The visible minimum length of an animation, in px of lane (decision 1); the Detailed view trades legibility for finer packing. */
const MIN_LEN_PX = 24;
const MIN_LEN_PX_DETAILED = 10;
/** Gap between two clicks on one diamond that still counts as a double-click. */
const DOUBLE_CLICK_MS = 400;

/** Round to the export frame grid, then to whole ms (sidecar times stay integers). */
function snapToFrame(ms: number): number {
  return Math.round(Math.round(ms / FRAME_MS) * FRAME_MS);
}

/** What a merged delete writes: the collapsed track, or the static single-key doc freezing the surviving pose (decision 4), so losing the last animation holds the shot instead of leaving a lone diamond. */
function withFrozenPose<P, T extends KeyedTrack<P>>(result: MergedDelete<P, T>): T {
  if (result.frozenPose === undefined) return result.track;
  return {
    ...result.track,
    keys: [{ id: nextKeyId(result.track), tMs: 0, pose: result.frozenPose }],
    segments: [],
  };
}

/** Keeps the keys some resolved animation joins: the rest (a legacy stray, or the frozen static pose) are invisible on the lane and unpickable. */
function hasSegment<P>(layout: TrackLayout<P>): (key: KeyedTrackKey<P>) => boolean {
  const attached = new Set(layout.segments.flatMap((s) => [s.fromId, s.toId]));
  return (key) => attached.has(key.id);
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
  /** Scene-local start of the ATTRIBUTION window (half the incoming overlap): the lane's left edge. */
  windowStartMs: number;
  /** Scene-local end of the attribution window (duration minus half the outgoing overlap): the lane's right edge. */
  windowEndMs: number;
  /** Scene-local end of the incoming transition: where a first animation starts. Lanes with no transition awareness pass `windowStartMs`. */
  transitionInMs: number;
  /** Scene-local start of the outgoing transition: where an auto-placed animation stops. Lanes with no transition awareness pass `windowEndMs`. */
  transitionOutStartMs: number;
  /** No scene follows: lane seeks may land exactly on the window end (else they stop 1ms short so the chrome can never retarget to the next scene mid-drag). */
  lastScene: boolean;
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
  /** Names the add button when lanes stack ("＋ Camera" / "＋ Comparison"), so each track states what it animates without a label column; absent keeps "＋ Animation", the single-lane look byte for byte. */
  label?: string;
  /** Extra root class for per-lane theming (`lane-compare` recolours diamonds and segments via --lane-accent). */
  laneClassName?: string;
  /** Double-clicking a diamond activates it (the chart lane opens the data modal on that key); absent leaves the second click a plain select. */
  onKeyActivate?: (keyId: string) => void;
  /** Segment extras the camera rig opts into. Absent (the layered-screenshot lane) drops the popover's Advanced group; the lane NEVER branches on track type to decide this. */
  segmentExtras?: SegmentExtras;
  /** Soundtrack guidance (scene-local ms): faint beat ticks and stronger key-moment lines behind the keys, both joining the snap candidates. Absent keeps the lane byte for byte. */
  beatMarkers?: { beats: number[]; keyMoments: number[] };
}

/** The rig's per-segment controls, passed in rather than detected: smoothing and the three optional channel eases. */
export interface SegmentExtras {
  /** Absent in the sidecar means smooth, so the toggle shows on for absent. */
  smooth: (docIndex: number) => boolean;
  onSmooth: (docIndex: number, smooth: boolean) => void;
  /** The override for one channel, or undefined when it follows the segment's ease. */
  channelEase: (docIndex: number, channel: SegmentEaseChannel) => string | undefined;
  onChannelEase: (docIndex: number, channel: SegmentEaseChannel, ease: string | undefined) => void;
}

export function TrackLane<P, T extends KeyedTrack<P>>({
  open,
  slotStartMs,
  durationMs,
  windowStartMs,
  windowEndMs,
  transitionInMs,
  transitionOutStartMs,
  lastScene,
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
  label,
  laneClassName,
  onKeyActivate,
  segmentExtras,
  beatMarkers,
}: TrackLaneProps<P, T>) {
  const currentMs = useClockStore((s) => s.currentMs);
  const detailed = useUiStore((s) => s.detailedAnimationView);

  const trackRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);
  const [drag, setDrag] = useState<DragState<T> | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [durEdit, setDurEdit] = useState<string | null>(null);
  /** The gap neighbour the dragged key would merge into on release (decision 2). */
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  // Diamonds capture the pointer and preventDefault, so no native dblclick reaches them: the pair is counted here off the event's own timestamp.
  const lastKeyClickRef = useRef<{ id: string; at: number } | null>(null);
  /** The animation the easing popover is open for; only the context menu opens it. */
  const [easingSegment, setEasingSegment] = useState<number | null>(null);
  const [resizeSegIndex, setResizeSegIndex] = useState<number | null>(null);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    setTrackW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The lane spans the scene's attribution window (mid-transition to mid-transition); key times stay absolute scene-local, only the visible span changes.
  const windowMs = Math.max(1, windowEndMs - windowStartMs);
  const innerW = Math.max(0, trackW - PAD * 2);
  const pxPerMs = innerW > 0 ? innerW / windowMs : 0;
  const playheadLocal = Math.min(windowEndMs, Math.max(windowStartMs, currentMs - slotStartMs));
  const layout = trackLayout(track);
  // Only keys an animation joins are drawn (a frozen static pose has none), so only those can be picked.
  const shown = { keys: layout.keys.filter(hasSegment(layout)), segments: [] };
  const ctx: TrackContext = {
    durationMs,
    windowStartMs,
    windowEndMs,
    transitionInMs,
    transitionOutStartMs,
  };
  // The visible floor in ms at the CURRENT lane width, so a narrow window keeps its animations grabbable.
  const minLenMs = Math.max(
    2 * MIN_KEY_GAP_MS,
    pxPerMs > 0 ? (detailed ? MIN_LEN_PX_DETAILED : MIN_LEN_PX) / pxPerMs : 0,
  );

  const xOf = (tMs: number) =>
    PAD + (Math.min(windowEndMs, Math.max(windowStartMs, tMs)) - windowStartMs) * pxPerMs;

  const beatSnapTimes = beatMarkers
    ? [...beatMarkers.beats, ...beatMarkers.keyMoments].filter(
        (t) => t >= windowStartMs && t <= windowEndMs,
      )
    : [];

  /** Every lane seek clamps inside this scene's attribution window, so dragging the lane can never retarget the chrome to a neighbouring scene. */
  function seekLocal(tMs: number) {
    commitFocusedInspectorEdit();
    seekSceneLocal(slotStartMs, tMs, { windowStartMs, windowEndMs, lastScene });
  }

  /** Every add path lands the same way: commit, select the new diamond, then scrub the playhead onto it, so the edit you just made is the one on screen. */
  function commitAdded(next: T) {
    const added = addedKey(track, next);
    void commit(next);
    if (!added) return;
    select(added.id, null);
    seekLocal(added.tMs);
  }

  /** Seek to the 25% point of the containing animation when the playhead sits mid-span, where an edit is hard to see. */
  function driftPlayhead() {
    const target = playheadDriftTarget(track, playheadLocal);
    if (target === null) return;
    seekLocal(target);
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
        const next = moveKey(
          track,
          key.id,
          snapToFrame(key.tMs + frames * FRAME_MS),
          durationMs,
          minLenMs,
        );
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
          const result = deleteKeyMerged(track, selection.keyId);
          if (result) {
            select(null, null);
            void commit(withFrozenPose(result));
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, track, commit, durationMs, minLenMs, select, getSelection, onToolKey, onEscape]);

  // ── Drags ─────────────────────────────────

  function onKeyPointerDown(e: React.PointerEvent, keyId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault(); // a drag must never paint a native text selection
    e.currentTarget.setPointerCapture(e.pointerId);
    setEasingSegment(null);
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
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setEasingSegment(null);
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

  /** Scrub to the pointer: seek the playhead (snapped to keys + the window edges), then select the nearest diamond so arrows/move tools target the key you scrubbed to. */
  function scrubAt(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || pxPerMs <= 0) return;
    let local = windowStartMs + (clientX - rect.left - PAD) / pxPerMs;
    const snapRadius = SNAP_PX / pxPerMs;
    for (const target of [
      windowStartMs,
      windowEndMs,
      ...beatSnapTimes,
      ...shown.keys.map((k) => Math.min(windowEndMs, Math.max(windowStartMs, k.tMs))),
    ]) {
      if (Math.abs(local - target) <= snapRadius) local = target;
    }
    seekLocal(local);
    const near = nearestKey(shown, Math.min(windowEndMs, Math.max(windowStartMs, local)));
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
      // Snap to the nearest of beats + playhead within radius (playhead wins ties), then to the frame grid.
      const snapRadius = SNAP_PX / pxPerMs;
      let snapped: number | null = null;
      let bestD = snapRadius;
      for (const cand of [...beatSnapTimes, playheadLocal]) {
        const d = Math.abs(target - cand);
        if (d <= bestD) {
          bestD = d;
          snapped = cand;
        }
      }
      if (snapped !== null) target = snapped;
      const next = moveKey(drag.orig, drag.id, snapToFrame(target), durationMs, minLenMs);
      if (!next) return;
      const moved = next.keys.find((k) => k.id === drag.id);
      setMergeTarget(moved ? mergeCandidate(drag.orig, drag.id, moved.tMs) : null);
      preview(next, false);
    } else {
      const next = moveSegment(
        drag.orig,
        drag.fromId,
        drag.toId,
        snapToFrame(dx / pxPerMs),
        durationMs,
        minLenMs,
      );
      if (next) preview(next, false);
    }
  }

  /** The key a dragged key would merge into: only a legacy gap has one, the neighbour on the other side, and only once the drag is within the snap radius of it (decision 2, connect-on-drag). */
  function mergeCandidate(base: T, keyId: string, tMs: number): string | null {
    if (pxPerMs <= 0) return null;
    const { prevSeg, nextSeg } = junctionInfo(base, keyId);
    if (Boolean(prevSeg) === Boolean(nextSeg)) return null;
    const segments = trackLayout(base).segments;
    const across = prevSeg
      ? segments.filter((s) => s.fromId !== keyId && s.fromTMs >= tMs).at(0)?.fromId
      : segments.filter((s) => s.toId !== keyId && s.toTMs <= tMs).at(-1)?.toId;
    const target = across ? base.keys.find((k) => k.id === across) : null;
    // Never under the data floor: on a short scene the wall parks the key further out than the snap radius.
    const range = Math.max(SNAP_PX / pxPerMs, MIN_KEY_GAP_MS);
    if (!target || Math.abs(target.tMs - tMs) > range) return null;
    return mergeGap(base, keyId, target.id) ? target.id : null;
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!drag) return;
    if (drag.kind === "scrub") {
      setDrag(null);
      return;
    }
    if (drag.kind === "key") {
      if (drag.moved) {
        // Dropped on its gap neighbour: the two collapse into one shared junction (decision 2).
        const merged = mergeTarget ? mergeGap(track, drag.id, mergeTarget) : null;
        if (merged) select(mergeTarget, null);
        void commit(merged ?? track);
      } else {
        // Click: select the diamond AND seek the playhead to it (window-clamped, so an edge key never hops the chrome to a neighbouring scene).
        select(drag.id, null);
        const key = track.keys.find((k) => k.id === drag.id);
        if (key) seekLocal(key.tMs);
        const last = lastKeyClickRef.current;
        if (onKeyActivate && last?.id === drag.id && e.timeStamp - last.at <= DOUBLE_CLICK_MS) {
          lastKeyClickRef.current = null;
          onKeyActivate(drag.id);
        } else {
          lastKeyClickRef.current = { id: drag.id, at: e.timeStamp };
        }
      }
    } else {
      if (drag.moved) void commit(track);
      else {
        // Click: select the animation and drift the playhead; easing lives in the right-click menu now.
        select(null, drag.docIndex);
        driftPlayhead();
      }
    }
    setMergeTarget(null);
    setDrag(null);
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setEasingSegment(null);
    setDrag({ kind: "scrub" });
    scrubAt(e.clientX);
  }

  /** Right-click a keyframe: the connected edits, each probed so a disabled item can say why. */
  function onKeyContextMenu(e: React.MouseEvent, keyId: string) {
    e.preventDefault();
    e.stopPropagation();
    select(keyId, null);
    const after = duplicateKey(track, ctx, keyId, minLenMs);
    const before = duplicateKeyBefore(track, ctx, keyId, minLenMs);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "duplicate",
          label: "Duplicate",
          disabled: !after,
          title: after
            ? "Hold this pose, then run the animation after it from halfway"
            : "No room after this keyframe for a hold",
          onSelect: () => {
            if (after) commitAdded(after);
          },
        },
        {
          id: "duplicate-before",
          label: "Duplicate before",
          disabled: !before,
          title: before
            ? "Hold this pose, arriving halfway through the animation before it"
            : "No room before this keyframe for a hold",
          onSelect: () => {
            if (before) commitAdded(before);
          },
        },
        {
          id: "delete",
          label: "Delete",
          danger: true,
          title: "Joins the animations either side; the last one leaves the pose frozen",
          onSelect: () => {
            const result = deleteKeyMerged(track, keyId);
            if (result) {
              select(null, null);
              void commit(withFrozenPose(result));
            }
          },
        },
      ],
    });
  }

  /** Right-click an animation: easing, resize, split at the clicked point, delete. */
  function onSegmentContextMenu(e: React.MouseEvent, docIndex: number) {
    e.preventDefault();
    select(null, docIndex);
    const bounds = resizeBounds(track, ctx, docIndex, minLenMs);
    const rect = trackRef.current?.getBoundingClientRect();
    const clickedT =
      rect && pxPerMs > 0
        ? snapToFrame(windowStartMs + (e.clientX - rect.left - PAD) / pxPerMs)
        : null;
    const splitNext =
      clickedT === null
        ? null
        : splitSegmentAt(track, docIndex, clickedT, poseAt(clickedT), minLenMs);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "easing",
          label: "Easing…",
          title: "How this animation is paced",
          onSelect: () => setEasingSegment(docIndex),
        },
        {
          id: "resize",
          label: "Resize…",
          disabled: !bounds,
          title: bounds
            ? "Type its length; later keyframes shift with it"
            : "This animation has no room to resize",
          onSelect: () => setResizeSegIndex(docIndex),
        },
        {
          id: "add-key",
          label: "Add keyframe",
          disabled: !splitNext,
          title: splitNext
            ? "Splits the animation here; the camera keeps its position at this point"
            : "Too close to a keyframe to split here",
          onSelect: () => {
            if (splitNext) commitAdded(splitNext);
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

  // The playhead's animation tints the bar; the glowing diamond is the key a camera edit will write to (the selected key, else the nearest), mirroring the pill and tool overlays.
  const activeSegment =
    layout.segments.find((s) => playheadLocal >= s.fromTMs && playheadLocal <= s.toTMs) ?? null;
  const selectedKey = shown.keys.find((k) => k.id === selectedKeyId);
  const targetKey = selectedKey ?? nearestKey(shown, playheadLocal);
  const nearIds = [targetKey?.id ?? ""];

  // Probed every render: null means nothing fits at this playhead, which is what disables the button.
  const addNext = addAnimationAuto(track, ctx, snapToFrame(playheadLocal), poseAt, minLenMs);
  const easingLayout =
    easingSegment === null
      ? null
      : (layout.segments.find((s) => s.docIndex === easingSegment) ?? null);
  const resizeSegBounds =
    resizeSegIndex === null ? null : resizeBounds(track, ctx, resizeSegIndex, minLenMs);

  function finishDurationEdit(commitEdit: boolean) {
    const text = durEdit;
    setDurEdit(null);
    if (!commitEdit || text === null) return;
    const ms = parseSceneLengthMs(text);
    if (ms === null) return;
    if (ms !== durationMs) onSceneDuration(ms);
  }

  return (
    <div
      className={`anim-lane${open ? " open" : ""}${laneClassName ? ` ${laneClassName}` : ""}`}
      aria-hidden={!open}
    >
      <div className="anim-lane-row">
        <button
          type="button"
          className="btn primary btn-small"
          title={addNext ? addTitle : "No room left in this scene for another animation"}
          disabled={!addNext}
          onClick={() => {
            if (addNext) commitAdded(addNext);
          }}
        >
          ＋ {label ?? "Animation"}
        </button>

        <div
          className="anim-track"
          ref={trackRef}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {beatMarkers?.beats.map((t) =>
            t >= windowStartMs && t <= windowEndMs ? (
              <span key={`beat-${t}`} className="anim-beat-tick" style={{ left: xOf(t) }} />
            ) : null,
          )}
          {beatMarkers?.keyMoments.map((t) =>
            t >= windowStartMs && t <= windowEndMs ? (
              <span
                key={`moment-${t}`}
                className="anim-beat-tick strong"
                style={{ left: xOf(t) }}
              />
            ) : null,
          )}
          {layout.segments.map((seg) => {
            const left = xOf(seg.fromTMs);
            const width = Math.max(innerW * MIN_SEGMENT_VISUAL, xOf(seg.toTMs) - left);
            // A segment living entirely inside a trimmed transition half pins at the lane edge, cued like edge keys.
            const outside = seg.toTMs <= windowStartMs || seg.fromTMs >= windowEndMs;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: pointer-driven editing surface — keyboard editing rides the window-level Delete/arrow handlers
              <div
                key={`${seg.fromId}-${seg.toId}`}
                className={`anim-seg${selectedSegment === seg.docIndex ? " selected" : ""}${
                  seg.ease === "jump" ? " jump" : ""
                }${activeSegment?.docIndex === seg.docIndex ? " at-playhead" : ""}${outside ? " overhang" : ""}`}
                style={{ left, width }}
                title={
                  outside
                    ? `Animation at ${(seg.fromTMs / 1000).toFixed(2)}s, inside the transition (shown at the lane edge)`
                    : `Animation ${seg.ease === "jump" ? "(jump cut)" : `(${seg.ease})`}, drag to move, right-click for easing, resize and delete`
                }
                onPointerDown={(e) => onSegmentPointerDown(e, seg.docIndex, seg.fromId, seg.toId)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={(e) => onSegmentContextMenu(e, seg.docIndex)}
              />
            );
          })}
          {shown.keys.map((key) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: pointer-driven editing surface, keyboard editing rides the window-level Delete/arrow handlers
            <div
              key={key.id}
              className={`anim-key${detailed ? " detailed" : ""}${
                selectedKeyId === key.id ? " selected" : ""
              }${nearIds.includes(key.id) ? " near" : ""}${
                mergeTarget === key.id ? " merge-target" : ""
              }${key.tMs < windowStartMs || key.tMs > windowEndMs ? " overhang" : ""}`}
              style={{ left: xOf(key.tMs) }}
              title={
                key.tMs > durationMs
                  ? `Keyframe at ${(key.tMs / 1000).toFixed(2)}s, past the scene end (holds clamp)`
                  : key.tMs < windowStartMs || key.tMs > windowEndMs
                    ? `Keyframe at ${(key.tMs / 1000).toFixed(2)}s, inside the transition (shown at the lane edge)`
                    : `Keyframe at ${(key.tMs / 1000).toFixed(2)}s, drag to retime, right-click to duplicate or delete`
              }
              onPointerDown={(e) => onKeyPointerDown(e, key.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onContextMenu={(e) => onKeyContextMenu(e, key.id)}
            />
          ))}
          <span className="anim-playhead" style={{ left: xOf(playheadLocal) }} />
        </div>

        <span className="anim-readout">
          {`${formatSceneLengthMs(playheadLocal)} / `}
          {durEdit !== null ? (
            <input
              className="anim-duration-input"
              data-space-plays=""
              value={durEdit}
              // biome-ignore lint/a11y/noAutofocus: entered by double-clicking the readout, so it IS the focus target
              autoFocus
              aria-label="Scene length in minutes and seconds"
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
              title="Scene length; double-click to type m:ss or seconds"
              onDoubleClick={() => setDurEdit(formatSceneLengthMs(durationMs))}
            >
              {formatSceneLengthMs(durationMs)}
            </button>
          )}
        </span>
      </div>

      {writeError && (
        <div className="anim-lane-error" role="alert">
          {writeErrorPrefix} {writeError}
        </div>
      )}

      {easingLayout && (
        <EasingPopover
          easeName={easingLayout.ease}
          onPick={(name) => {
            const next = setSegmentEase(track, easingLayout.docIndex, name);
            if (next) void commit(next);
          }}
          extras={segmentExtras}
          docIndex={easingLayout.docIndex}
          onClose={() => setEasingSegment(null)}
        />
      )}

      {resizeSegIndex !== null && resizeSegBounds && (
        <ResizeAnimationModal
          bounds={resizeSegBounds}
          onCommit={(spanMs) => {
            const next = resizeSegment(track, ctx, resizeSegIndex, spanMs, minLenMs);
            setResizeSegIndex(null);
            if (next && next !== track) void commit(next);
          }}
          onCancel={() => setResizeSegIndex(null)}
        />
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ── Easing popover ───────────────────────────────────

const CHANNELS: { channel: SegmentEaseChannel; label: string; hint: string }[] = [
  { channel: "easePosition", label: "Position", hint: "How the camera's travel is paced" },
  { channel: "easeRotation", label: "Rotation", hint: "How the aim and roll are paced" },
  { channel: "easeLens", label: "Lens", hint: "How the field of view is paced" },
  { channel: "easeDof", label: "Focus", hint: "How the depth-of-field focus and blur are paced" },
];

const CURVE_SAMPLES = 12;

/** One ease drawn from the curve itself: 12 samples of `ease` as a polyline, so Linear reads as a diagonal and Jump cut as a step with no per-name artwork. Back's overshoot fits inside the 2px margin. */
export function EaseCurveIcon({ name }: { name: string }) {
  const points = Array.from({ length: CURVE_SAMPLES }, (_, i) => {
    const t = i / (CURVE_SAMPLES - 1);
    return `${(2 + t * 12).toFixed(2)},${(14 - ease(name, t) * 12).toFixed(2)}`;
  }).join(" ");
  return (
    <svg className="ease-curve-icon" viewBox="0 0 16 16" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function EasingPopover({
  easeName,
  onPick,
  extras,
  docIndex,
  onClose,
}: {
  easeName: string;
  onPick: (ease: string) => void;
  extras?: SegmentExtras;
  docIndex: number;
  onClose: () => void;
}) {
  const [channelsOpen, setChannelsOpen] = useState(false);
  // Parse "inQuad"/"outSine"/"inOutBack" into direction + family for the grid state.
  const m = /^(in|out|inOut)([A-Z][a-z]+)$/.exec(easeName);
  const family = m ? m[2] : "Quad";
  const dir = m ? m[1] : "inOut";
  const chip = (value: string, label: string, icon = false) => (
    <button
      type="button"
      key={value + label}
      className={`chip${easeName === value ? " selected" : ""}`}
      onClick={() => onPick(value)}
    >
      {icon && <EaseCurveIcon name={value} />}
      {label}
    </button>
  );
  return (
    <div className="camera-easing" role="menu" aria-label="Segment easing">
      <div className="camera-easing-head">
        <span className="camera-easing-title">Easing</span>
        <button
          type="button"
          className="camera-easing-close"
          title="Done"
          aria-label="Close easing options"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="camera-easing-group">
        <span className="drill-group-label">Style</span>
        <div className="camera-easing-row">
          {chip(DEFAULT_EASE, "Default", true)}
          {chip("linear", "Linear", true)}
          {chip("jump", "Jump cut", true)}
        </div>
      </div>
      <div className="camera-easing-group">
        <span className="drill-group-label">Direction</span>
        <div className="camera-easing-row">
          {chip(`in${family}`, "In")}
          {chip(`out${family}`, "Out")}
          {chip(`inOut${family}`, "In Out")}
        </div>
      </div>
      <div className="camera-easing-group">
        <span className="drill-group-label">Family</span>
        <div className="camera-easing-families">
          {EASE_FAMILIES.map((f) => (
            <button
              type="button"
              key={f}
              className={`chip${family === f && m ? " selected" : ""}`}
              onClick={() => onPick(`${dir}${f}`)}
            >
              <EaseCurveIcon name={`${dir}${f}`} />
              {f}
            </button>
          ))}
        </div>
      </div>
      {extras && (
        <div className="camera-easing-group">
          <span className="drill-group-label">Advanced</span>
          <ToggleRow
            label="Smooth through keys"
            description="Curve the path through its neighbouring keys instead of running straight"
            checked={extras.smooth(docIndex)}
            onChange={(on) => extras.onSmooth(docIndex, on)}
          />
          <button
            type="button"
            className="camera-easing-disclosure"
            aria-expanded={channelsOpen}
            onClick={() => setChannelsOpen((open) => !open)}
          >
            {channelsOpen ? "▾" : "▸"} Per-channel easing
          </button>
          {channelsOpen &&
            CHANNELS.map(({ channel, label, hint }) => {
              const value = extras.channelEase(docIndex, channel);
              return (
                <div key={channel} className="camera-easing-channel" title={hint}>
                  <span className="camera-easing-channel-label">{label}</span>
                  <select
                    value={value ?? ""}
                    onChange={(e) =>
                      extras.onChannelEase(docIndex, channel, e.target.value || undefined)
                    }
                  >
                    <option value="">Same as segment</option>
                    <option value="linear">Linear</option>
                    <option value="jump">Jump cut</option>
                    {EASE_FAMILIES.flatMap((f) =>
                      (["in", "out", "inOut"] as const).map((dir) => (
                        <option key={`${dir}${f}`} value={`${dir}${f}`}>{`${dir}${f}`}</option>
                      )),
                    )}
                  </select>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
