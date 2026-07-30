import { useEffect, useRef } from "react";
import type { EditClip, EditSource } from "../engine/edit";
import { clipIndexAt, timelineDurationMs, timelineToSource } from "../engine/editMath";
import { fsUrl } from "../engine/media";

/** The read-only reference pane: another scene video scrub-locked to the active edit in OUTPUT time (its own edit doc applied when one exists), so trims and speed changes on either side stay honest. Paused it seeks the mapped frame; playing it runs its own decode clock at the clip's speed with drift correction against the lockstep time; past either end it holds a dimmed first/last frame so misalignment is visible rather than blank. Preview-only, never the export path. */

const SEEK_EPSILON_MS = 30;
const DRIFT_MS = 150;

function effectiveSpeed(speed: number): number {
  return speed > 0 ? speed : 1;
}

export function ReferencePane({
  clips,
  sources,
  basePath,
  timeMs,
  playing,
}: {
  clips: EditClip[];
  sources: EditSource[];
  /** The lockstep time: active playhead plus the reference offset, in the reference's output ms. */
  timeMs: number;
  basePath: string;
  playing: boolean;
}) {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const total = timelineDurationMs(clips);
  const outOfRange = timeMs < 0 || timeMs >= total;
  const clamped = Math.min(Math.max(timeMs, 0), Math.max(0, total - 1));
  const idx = clipIndexAt(clips, clamped);
  const clip = idx >= 0 ? clips[idx] : null;
  const activeSourceId = clip?.sourceId ?? sources[0]?.id ?? null;

  useEffect(() => {
    const frozen = clip?.holdMs !== undefined;
    for (const [id, video] of videos.current) {
      if (!playing || outOfRange || frozen || id !== activeSourceId) {
        if (!video.paused) video.pause();
      }
    }
    if (!clip) return;
    const video = videos.current.get(clip.sourceId);
    if (!video) return;
    const srcMs = frozen ? clip.inMs : timelineToSource(clip, clamped);
    if (!playing || outOfRange || frozen) {
      if (Math.abs(video.currentTime * 1000 - srcMs) > SEEK_EPSILON_MS) {
        video.currentTime = srcMs / 1000;
      }
      return;
    }
    const speed = effectiveSpeed(clip.speed);
    if (video.playbackRate !== speed) video.playbackRate = speed;
    if (Math.abs(video.currentTime * 1000 - srcMs) > DRIFT_MS) {
      video.currentTime = srcMs / 1000;
    }
    if (video.paused) void video.play();
  }, [playing, outOfRange, clamped, clip, activeSourceId]);

  return (
    <div className={`editor-reference${outOfRange ? " out-of-range" : ""}`}>
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
          </div>
        </div>
      ))}
    </div>
  );
}
