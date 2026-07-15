import { useCallback, useEffect, useRef, useState } from "react";

/** Minimal-chrome video player: replaces WKWebView's native controls in the fullscreen media preview with play/pause, a seekable progress bar, timecodes, and frame-accurate transport (Space play/pause, ←/→ one frame, ⇧ = 10); reused by every MediaBrowser host. Single-source only, the editor's timeline preview (editor/Preview.tsx) keeps its own multi-source clock mapping. */

export interface VideoPlayerProps {
  src: string;
  /** Source frame rate for ←/→ stepping (falls back to 60). */
  fps?: number;
  autoPlay?: boolean;
}

function fmtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function VideoPlayer({ src, fps, autoPlay }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const effFps = fps && fps > 0 ? fps : 60;

  // Smooth progress while playing (timeupdate alone ticks ~4Hz).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) setTime(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  /** Pause and nudge N frames on the source's frame grid. */
  const stepFrames = useCallback(
    (frames: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      const frameS = 1 / effFps;
      const frame = Math.round(video.currentTime / frameS) + frames;
      video.currentTime = Math.min(video.duration || 0, Math.max(0, frame * frameS));
      setTime(video.currentTime);
    },
    [effFps],
  );

  // Transport keys for the lifetime of the player (the fullscreen preview).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        stepFrames((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, stepFrames]);

  const seekTo = useCallback((clientX: number) => {
    const video = videoRef.current;
    const track = trackRef.current;
    if (!video || !track || !video.duration) return;
    const rect = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    video.currentTime = f * video.duration;
    setTime(video.currentTime);
  }, []);

  return (
    <div className="video-player">
      {/* biome-ignore lint/a11y/useMediaCaption: user-imported footage has no captions */}
      <video
        ref={videoRef}
        src={src}
        autoPlay={autoPlay}
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          if (!playing) setTime(e.currentTarget.currentTime);
        }}
      />
      <div className="video-player-bar">
        <button
          type="button"
          className="btn video-player-play"
          onClick={toggle}
          title="Play/pause (Space)"
        >
          {playing ? "⏸" : "▶"}
        </button>
        <span className="video-player-time">{fmtTime(time)}</span>
        <div
          className="video-player-track"
          ref={trackRef}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            videoRef.current?.pause();
            seekTo(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) seekTo(e.clientX);
          }}
        >
          <div
            className="video-player-fill"
            style={{ width: `${duration > 0 ? (time / duration) * 100 : 0}%` }}
          />
        </div>
        <span className="video-player-time">{fmtTime(duration)}</span>
      </div>
    </div>
  );
}
