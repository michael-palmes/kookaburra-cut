import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type { EditClip, EditSource, EditTap } from "../engine/edit";
import { clipIndexAt, timelineDurationMs, timelineToSource } from "../engine/editMath";
import { fsUrl } from "../engine/media";
import { useEscapeClose } from "../ui/useEscapeClose";
import {
  TAP_DOT_SIZE_FRACTION,
  TAP_MARKER_NEAR_MS,
  tapDotFrame,
  tapGradient,
  tapProgress,
} from "./tapAnimation";
import { TAP_COLORS, TAP_STYLES } from "./tapStyles.generated";

/** The preview controller: one muted <video> per source, driven by the playhead. While paused, scrubbing seeks the active source to the mapped time; while playing, the active video's clock is master, each frame maps `currentTime` back to timeline time (no wall clock, no drift) and advances across clip boundaries. Freeze clips have no decode clock, so they advance on rAF frame time with the source parked on the pinned frame. A contiguous same-source boundary (a split) plays straight through without a seek. Preview-only playback, never the export path (renders re-cut from the sources). */

const SEEK_EPSILON_MS = 30; // don't spam sub-frame seeks on playhead scrubs
const TRIM_SEEK_EPSILON_MS = 4; // trim scrubbing is frame-exact, seek on any real change

/** A transient viewer override while a trim handle is dragged: show THIS source frame. */
export interface TrimScrub {
  sourceId: string;
  sourceMs: number; // the draft edge, in source time
  edge: "in" | "out"; // out-points are exclusive, display the last included frame
}

export interface PreviewProps {
  clips: EditClip[]; // relaid (magnetic)
  sources: EditSource[];
  basePath: string; // absolute project folder (sources resolve via the asset protocol)
  playheadMs: number;
  playing: boolean;
  trimScrub?: TrimScrub | null;
  onPlayhead: (ms: number) => void; // playback ticks (timeline time)
  onStop: () => void; // reached the end (or nothing left to play)
  armedTap: boolean; // the tap tool: click the frame to place a highlight
  canPlaceTap: boolean; // playhead is on a placeable moment (not a freeze, not off-timeline)
  taps: EditTap[];
  tapWindowList: { tap: EditTap; startMs: number; endMs: number }[]; // output windows, precomputed
  onPlaceTap: (pos: [number, number]) => void; // pos normalised 0..1 across the source frame
  onCommitTap: (id: string, pos: [number, number]) => void; // one commit per drag gesture
  onTapContextMenu: (id: string, clientX: number, clientY: number) => void;
  tapMarkerScope: "near" | "all"; // "near" shows edit markers only around the playhead
  onTapMarkerScope: (scope: "near" | "all") => void;
  tapStyle: string; // style (shape) id (tapStyles.generated.ts)
  onTapStyle: (id: string) => void;
  tapColor: string; // colour id (tapStyles.generated.ts)
  onTapColor: (id: string) => void;
  tapSize: number; // multiplier on the default dot size
  onTapSize: (size: number) => void;
}

/** The floating tap-settings overlay (camera-pill styling): marker scope, style dropdown with live swatches, colour dots and size. */
function TapSettings({
  scope,
  onScope,
  styleId,
  onStyle,
  colorId,
  onColor,
  size,
  onSize,
}: {
  scope: "near" | "all";
  onScope: (scope: "near" | "all") => void;
  styleId: string;
  onStyle: (id: string) => void;
  colorId: string;
  onColor: (id: string) => void;
  size: number;
  onSize: (size: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEscapeClose(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  const style = TAP_STYLES.find((s) => s.id === styleId) ?? TAP_STYLES[0];
  const color = TAP_COLORS.find((c) => c.id === colorId) ?? TAP_COLORS[0];
  // The swatch backdrop splits light/dark so every style's visibility is previewable; the dot layer draws at 82% so its silhouette never touches the chip's edge.
  const swatch = (gradient: string): CSSProperties => ({
    backgroundImage: `${gradient}, linear-gradient(105deg, #f2f2f2 50%, #20262b 50%)`,
    backgroundSize: "82% 82%, 100% 100%",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  });
  return (
    <div className="tap-settings" ref={ref}>
      <div className="tap-settings-scope">
        <button
          type="button"
          className={`tap-settings-seg${scope === "near" ? " selected" : ""}`}
          aria-pressed={scope === "near"}
          onClick={() => onScope("near")}
          title="Show tap markers near the playhead only"
        >
          Near
        </button>
        <button
          type="button"
          className={`tap-settings-seg${scope === "all" ? " selected" : ""}`}
          aria-pressed={scope === "all"}
          onClick={() => onScope("all")}
          title="Show every tap marker on this source"
        >
          All
        </button>
      </div>
      <div className="tap-settings-style">
        <button
          type="button"
          className="tap-settings-style-btn"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title="Tap highlight style (applies to the whole edit)"
        >
          <span className="tap-swatch" style={swatch(tapGradient(style, color))} />
          <span className="tap-settings-style-label">{style.label}</span>
          <span className="tap-settings-chevron" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <div className="tap-settings-menu">
            {TAP_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`tap-settings-option${s.id === style.id ? " selected" : ""}`}
                aria-pressed={s.id === style.id}
                onClick={() => {
                  onStyle(s.id);
                  setOpen(false);
                }}
              >
                <span className="tap-swatch" style={swatch(tapGradient(s, color))} />
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tap-settings-colors">
        {TAP_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`tap-settings-color${c.id === color.id ? " selected" : ""}`}
            aria-pressed={c.id === color.id}
            title={c.label}
            style={{ background: `rgb(${c.rgb.join(", ")})` }}
            onClick={() => onColor(c.id)}
          />
        ))}
      </div>
      <label className="tap-settings-size" title={`Tap size (${Math.round(size * 100)}%)`}>
        <span className="tap-settings-size-label">Size</span>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.05}
          value={size}
          onChange={(e) => onSize(Number(e.currentTarget.value))}
        />
      </label>
    </div>
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Pointer position normalised 0..1 against the video box rect. */
function posFromRect(e: { clientX: number; clientY: number }, rect: DOMRect): [number, number] {
  return [
    clamp01((e.clientX - rect.left) / rect.width),
    clamp01((e.clientY - rect.top) / rect.height),
  ];
}

function effectiveSpeed(speed: number): number {
  return speed > 0 ? speed : 1;
}

/** Clip index for DISPLAY: clamps t so the very end still shows the last clip. */
function displayIndexAt(clips: EditClip[], tMs: number): number {
  const total = timelineDurationMs(clips);
  return clipIndexAt(clips, Math.min(tMs, Math.max(0, total - 1)));
}

export function Preview({
  clips,
  sources,
  basePath,
  playheadMs,
  playing,
  trimScrub,
  onPlayhead,
  onStop,
  armedTap,
  canPlaceTap,
  taps,
  tapWindowList,
  onPlaceTap,
  onCommitTap,
  onTapContextMenu,
  tapMarkerScope,
  onTapMarkerScope,
  tapStyle,
  onTapStyle,
  tapColor,
  onTapColor,
  tapSize,
  onTapSize,
}: PreviewProps) {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  // Latest-value mirrors so the playback loop never restarts on scrub/edit.
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const playheadRef = useRef(playheadMs);
  playheadRef.current = playheadMs;

  const activeIdx = displayIndexAt(clips, playheadMs);
  const activeSourceId =
    trimScrub?.sourceId ?? (activeIdx >= 0 ? clips[activeIdx].sourceId : (sources[0]?.id ?? null));

  // Paused scrub: a trim-handle drag overrides the viewer with the exact edge frame; otherwise seek the active source to the playhead-mapped time.
  useEffect(() => {
    if (playing) return;
    if (trimScrub) {
      const video = videos.current.get(trimScrub.sourceId);
      if (!video) return;
      const source = sources.find((s) => s.id === trimScrub.sourceId);
      const fps = source && source.fps > 0 ? source.fps : 60;
      // The out-point is exclusive, show the last frame the clip keeps.
      const displayMs =
        trimScrub.edge === "out" ? Math.max(0, trimScrub.sourceMs - 500 / fps) : trimScrub.sourceMs;
      if (Math.abs(video.currentTime * 1000 - displayMs) > TRIM_SEEK_EPSILON_MS) {
        video.currentTime = displayMs / 1000;
      }
      return;
    }
    const idx = displayIndexAt(clips, playheadMs);
    if (idx < 0) return;
    const clip = clips[idx];
    const video = videos.current.get(clip.sourceId);
    if (!video) return;
    const srcMs = timelineToSource(clip, playheadMs);
    if (Math.abs(video.currentTime * 1000 - srcMs) > SEEK_EPSILON_MS) {
      video.currentTime = srcMs / 1000;
    }
  }, [playing, playheadMs, clips, trimScrub, sources]);

  // Transport: rAF loop, the active video's clock as the master.
  useEffect(() => {
    const pauseAll = () => {
      for (const video of videos.current.values()) video.pause();
    };
    if (!playing) {
      pauseAll();
      return;
    }
    let raf = 0;
    let disposed = false;
    let lastTs: number | null = null;

    const step = (ts: number) => {
      if (disposed) return;
      const dt = lastTs === null ? 0 : ts - lastTs;
      lastTs = ts;
      const now = clipsRef.current;
      const total = timelineDurationMs(now);
      const t = playheadRef.current;
      const idx = clipIndexAt(now, t);
      if (total <= 0 || idx < 0) {
        onStop();
        return;
      }
      const clip = now[idx];
      if (clip.holdMs !== undefined) {
        // Freeze: the source parks on the pinned frame (no decode clock), elapsed frame time advances the playhead instead.
        const held = videos.current.get(clip.sourceId);
        if (held) {
          if (!held.paused) held.pause();
          if (Math.abs(held.currentTime * 1000 - clip.inMs) > SEEK_EPSILON_MS) {
            held.currentTime = clip.inMs / 1000;
          }
        }
        const next = t + dt;
        if (next >= clip.startMs + clip.holdMs) {
          const following = now[idx + 1];
          if (!following) {
            onPlayhead(total);
            onStop();
            return;
          }
          onPlayhead(following.startMs);
        } else {
          onPlayhead(next);
        }
        raf = requestAnimationFrame(step);
        return;
      }
      const speed = effectiveSpeed(clip.speed);
      const video = videos.current.get(clip.sourceId);
      if (video) {
        if (video.paused) {
          // (Re)start this clip's source at the mapped time.
          const srcMs = timelineToSource(clip, t);
          if (Math.abs(video.currentTime * 1000 - srcMs) > SEEK_EPSILON_MS) {
            video.currentTime = srcMs / 1000;
          }
          video.playbackRate = speed;
          void video.play();
        } else {
          if (video.playbackRate !== speed) video.playbackRate = speed;
          const srcMs = video.currentTime * 1000;
          if (video.ended || srcMs >= clip.outMs - 1) {
            // Clip finished, advance or finish the timeline.
            const next = now[idx + 1];
            if (!next) {
              video.pause();
              onPlayhead(total);
              onStop();
              return;
            }
            if (next.sourceId !== clip.sourceId || next.holdMs !== undefined) {
              video.pause(); // the next clip's video starts (paused branch) next frame; a freeze parks it
            } else if (Math.abs(next.inMs - clip.outMs) > SEEK_EPSILON_MS) {
              video.currentTime = next.inMs / 1000; // same source, discontiguous
            } // contiguous split: play straight through
            onPlayhead(next.startMs);
          } else {
            onPlayhead(clip.startMs + (srcMs - clip.inMs) / speed);
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      pauseAll();
    };
  }, [playing, onPlayhead, onStop]);

  // Tap markers: one live drag at a time, rect frozen at gesture start, single commit on release.
  const dragRef = useRef<{ id: string; rect: DOMRect } | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; pos: [number, number] } | null>(null);

  // One-shot placement pulse: instant feedback when a tap lands, independent of the playhead. Preview-only wall clock, same as the transport rAF loop above (never the export path).
  const pulseRef = useRef<{ pos: [number, number]; start: number } | null>(null);
  const [pulseFrame, setPulseFrame] = useState<{
    pos: [number, number];
    opacity: number;
    scale: number;
  } | null>(null);
  const startPulse = useCallback((pos: [number, number]) => {
    pulseRef.current = { pos, start: performance.now() };
    setPulseFrame({ pos, ...tapDotFrame(0) });
  }, []);
  useEffect(() => {
    if (!pulseFrame) return;
    const raf = requestAnimationFrame(() => {
      const pulse = pulseRef.current;
      if (!pulse) return;
      const p = tapProgress(performance.now() - pulse.start);
      if (p === null) {
        pulseRef.current = null;
        setPulseFrame(null);
      } else {
        setPulseFrame({ pos: pulse.pos, ...tapDotFrame(p) });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [pulseFrame]);

  const style = TAP_STYLES.find((s) => s.id === tapStyle) ?? TAP_STYLES[0];
  const color = TAP_COLORS.find((c) => c.id === tapColor) ?? TAP_COLORS[0];
  const gradient = tapGradient(style, color);

  const dotStyle = (pos: [number, number], opacity: number, scale: number): CSSProperties => ({
    left: `${pos[0] * 100}%`,
    top: `${pos[1] * 100}%`,
    width: `${TAP_DOT_SIZE_FRACTION * 100 * tapSize}cqmin`,
    opacity,
    transform: `translate(-50%, -50%) scale(${scale})`,
    backgroundImage: gradient,
  });

  /** "Near" scope: an edit marker shows only while the playhead is within the margin of one of its windows; "all" also surfaces taps whose spans were trimmed out. */
  const markerVisible = (tap: EditTap): boolean => {
    if (tapMarkerScope === "all") return true;
    return tapWindowList.some(
      (w) =>
        w.tap.id === tap.id &&
        playheadMs >= w.startMs - TAP_MARKER_NEAR_MS &&
        playheadMs <= w.endMs + TAP_MARKER_NEAR_MS,
    );
  };

  return (
    <div className="editor-preview">
      {sources.map((source) => (
        <div
          key={source.id}
          className={`editor-video${source.id === activeSourceId ? "" : " hidden"}`}
        >
          <div
            className="editor-video-box"
            style={{
              aspectRatio:
                source.width > 0 && source.height > 0
                  ? `${source.width} / ${source.height}`
                  : undefined,
            }}
          >
            <video
              src={fsUrl(`${basePath}/${source.rel}`)}
              muted
              playsInline
              preload="auto"
              ref={(el) => {
                if (el) videos.current.set(source.id, el);
                else videos.current.delete(source.id);
              }}
            />
            {source.id === activeSourceId && (
              <>
                {armedTap && canPlaceTap && (
                  <div
                    className="tap-layer"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      const pos = posFromRect(e, e.currentTarget.getBoundingClientRect());
                      onPlaceTap(pos);
                      startPulse(pos);
                    }}
                  />
                )}
                {tapWindowList.map(({ tap, startMs, endMs }) => {
                  if (tap.sourceId !== source.id) return null;
                  if (playheadMs < startMs || playheadMs >= endMs) return null;
                  const p = tapProgress(playheadMs - startMs);
                  if (p === null) return null;
                  const { opacity, scale } = tapDotFrame(p);
                  return (
                    <div
                      key={`${tap.id}:${startMs}`}
                      className="tap-glow"
                      style={dotStyle(tap.pos, opacity, scale)}
                    />
                  );
                })}
                {pulseFrame && (
                  <div
                    className="tap-glow"
                    style={dotStyle(pulseFrame.pos, pulseFrame.opacity, pulseFrame.scale)}
                  />
                )}
                {taps.map((tap) => {
                  if (tap.sourceId !== source.id) return null;
                  if (dragPos?.id !== tap.id && !markerVisible(tap)) return null;
                  const pos = dragPos?.id === tap.id ? dragPos.pos : tap.pos;
                  return (
                    <button
                      key={tap.id}
                      type="button"
                      className={`tap-marker${armedTap ? " armed" : ""}`}
                      aria-label="Tap highlight: drag to move, right-click for options"
                      title="Tap highlight: drag to move, right-click for options"
                      style={{ left: `${pos[0] * 100}%`, top: `${pos[1] * 100}%` }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        const box = e.currentTarget.parentElement;
                        if (!box) return;
                        dragRef.current = { id: tap.id, rect: box.getBoundingClientRect() };
                        setDragPos({ id: tap.id, pos: tap.pos });
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const drag = dragRef.current;
                        if (!drag || drag.id !== tap.id) return;
                        setDragPos({ id: drag.id, pos: posFromRect(e, drag.rect) });
                      }}
                      onPointerUp={(e) => {
                        const drag = dragRef.current;
                        if (!drag || drag.id !== tap.id) return;
                        dragRef.current = null;
                        setDragPos(null);
                        onCommitTap(drag.id, posFromRect(e, drag.rect));
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onTapContextMenu(tap.id, e.clientX, e.clientY);
                      }}
                    />
                  );
                })}
              </>
            )}
          </div>
        </div>
      ))}
      {taps.length > 0 && (
        <TapSettings
          scope={tapMarkerScope}
          onScope={onTapMarkerScope}
          styleId={style.id}
          onStyle={onTapStyle}
          colorId={color.id}
          onColor={onTapColor}
          size={tapSize}
          onSize={onTapSize}
        />
      )}
      {clips.length === 0 && <p className="muted">No clips to preview.</p>}
    </div>
  );
}
