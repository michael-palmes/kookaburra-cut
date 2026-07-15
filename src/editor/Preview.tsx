import { useEffect, useRef } from "react";
import type { EditClip, EditSource } from "../engine/edit";
import { clipIndexAt, timelineDurationMs, timelineToSource } from "../engine/editMath";
import { fsUrl } from "../engine/media";

/** The preview controller: one muted <video> per source, driven by the playhead. While paused, scrubbing seeks the active source to the mapped time; while playing, the active video's clock is master, each frame maps `currentTime` back to timeline time (no wall clock, no drift) and advances across clip boundaries. A contiguous same-source boundary (a split) plays straight through without a seek. Preview-only playback, never the export path (renders re-cut from the sources). */

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

    const step = () => {
      if (disposed) return;
      const now = clipsRef.current;
      const total = timelineDurationMs(now);
      const t = playheadRef.current;
      const idx = clipIndexAt(now, t);
      if (total <= 0 || idx < 0) {
        onStop();
        return;
      }
      const clip = now[idx];
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
            if (next.sourceId !== clip.sourceId) {
              video.pause(); // the next clip's video starts (paused branch) next frame
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

  return (
    <div className="editor-preview">
      {sources.map((source) => (
        <div
          key={source.id}
          className={`editor-video${source.id === activeSourceId ? "" : " hidden"}`}
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
        </div>
      ))}
      {clips.length === 0 && <p className="muted">No clips to preview.</p>}
    </div>
  );
}
