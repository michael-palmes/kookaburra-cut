import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export interface PlaybackScene {
  /** Cell label (the scene's display name). */
  name: string;
  /** Scene duration; cells flex-weight by it so widths mirror the timeline. */
  durationMs: number;
}

export interface PlaybackBarProps {
  /** Swaps the play glyph for the pause glyph. */
  playing?: boolean;
  /** Scenes rendered as flex-weighted cells with a labels row beneath. */
  scenes: PlaybackScene[];
  /** Index of the active scene (accent-marked cell + label). */
  activeIndex?: number;
  /** Playhead position as a fraction of the whole timeline (0-1). */
  fraction?: number;
  /** Timecode readout, mono + tabular so digits never jitter (e.g. "00:02.4 / 00:08.2"). */
  readout?: string;
  muted?: boolean;
  disabled?: boolean;
  /** Shows the dashed New scene affordance after the readout. */
  onNewScene?: () => void;
  onPlayPause?: () => void;
  onToggleMute?: () => void;
  className?: string;
}

/**
 * Segmented per-scene playback bar (`playback-bar`, v13): round play/pause (a raised
 * fill — deliberately NOT accent-filled), a mute toggle, one flex-weighted cell per
 * scene with a 2px accent playhead over the track, a labels row, the mono readout and
 * a dashed New scene affordance. Scrubbing is frame-accurate stepping, never eased.
 */
export function PlaybackBar({
  playing,
  scenes,
  activeIndex = 0,
  fraction = 0,
  readout,
  muted,
  disabled,
  onNewScene,
  onPlayPause,
  onToggleMute,
  className,
}: PlaybackBarProps) {
  return (
    <div className={cx("playback-bar", className)}>
      <div className="pb-left">
        <button
          type="button"
          className="play-btn"
          disabled={disabled}
          onClick={onPlayPause}
          aria-label={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="2.5" y="1.5" width="3" height="11" rx="1" fill="currentColor" />
              <rect x="8.5" y="1.5" width="3" height="11" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3.5 2.2c0-.5.53-.8.96-.54l7 4.8a.64.64 0 0 1 0 1.08l-7 4.8a.64.64 0 0 1-.96-.54V2.2z"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={cx("pb-mute", muted && "muted")}
          onClick={onToggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 5h2.5L8 2.2v9.6L4.5 9H2z" fill="currentColor" />
            {muted ? (
              <path d="M10 5l3 4M13 5l-3 4" stroke="currentColor" strokeWidth="1.4" />
            ) : (
              <path
                d="M10 4.6a3.4 3.4 0 0 1 0 4.8"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
              />
            )}
          </svg>
        </button>
      </div>
      <div className="pb-center">
        <div className={cx("pb-track", disabled && "disabled")}>
          {scenes.map((s, i) => (
            <div
              key={s.name}
              className={cx("pb-cell", i === activeIndex && "active")}
              style={{ flexGrow: s.durationMs }}
            />
          ))}
          <div className="pb-playhead" style={{ left: `${fraction * 100}%` }} />
        </div>
        <div className="pb-labels">
          {scenes.map((s, i) => (
            <span
              key={s.name}
              className={cx("pb-label", i === activeIndex && "active")}
              style={{ flexGrow: s.durationMs }}
            >
              {s.name}
            </span>
          ))}
        </div>
      </div>
      <div className="pb-right">
        {readout ? <span className="pb-readout">{readout}</span> : null}
        {onNewScene ? (
          <button type="button" className="pb-new-scene" onClick={onNewScene}>
            ＋ New scene
          </button>
        ) : null}
      </div>
    </div>
  );
}

export type TimecodeProps = HTMLAttributes<HTMLSpanElement>;

/** Mono, tabular timecode text (`pb-readout`) — digits never reflow while changing. */
export function Timecode({ className, ...rest }: TimecodeProps) {
  return <span className={cx("pb-readout", className)} {...rest} />;
}
