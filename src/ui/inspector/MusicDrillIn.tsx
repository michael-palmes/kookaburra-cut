import { useEffect, useState } from "react";
import {
  AUDIO_FADE_CURVES,
  type AudioFadeCurve,
  DEFAULT_AUDIO_FADE_OUT_MS,
  type ProjectAudio,
  type ProjectAudioSpec,
} from "../../engine/project";
import { SceneMenuIcon } from "../sceneMenu";
import { DrillBack, DrillGroup, InspectorSliderRow } from "./rows";

/** The Project tab's Music drill: the soundtrack plus its whole mix surface (volume, start offset, fades and the fade-out shape), every control writing the same project.json `audio` block preview and export read. */

const CURVE_LABELS: Record<AudioFadeCurve, string> = {
  smooth: "Smooth",
  linear: "Linear",
  scurve: "S-curve",
  exponential: "Exponential",
  logarithmic: "Logarithmic",
};

function MusicControlIcon({
  type,
}: {
  type: "track" | "volume" | "offset" | "fadein" | "fadeout";
}) {
  const glyph = {
    track: (
      <>
        <path d="M8 15V5.5l7-1.5v9" />
        <circle cx="6" cy="15" r="2" />
        <circle cx="13" cy="13" r="2" />
      </>
    ),
    volume: (
      <>
        <path d="M4 8v4h3l4 3V5L7 8z" />
        <path d="M13.5 8a3.2 3.2 0 010 4M15.5 6.5a5.6 5.6 0 010 7" />
      </>
    ),
    offset: (
      <>
        <path d="M4 4.5v11" />
        <path d="M7.5 10h8M12.5 7l3 3-3 3" />
      </>
    ),
    fadein: <path d="M3 15C9 15 13 11 17 5" />,
    fadeout: <path d="M3 5c6 0 10 4 14 10" />,
  }[type];
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

/** The fade-out gain over time, one descending stroke per shape. */
function CurveIcon({ curve }: { curve: AudioFadeCurve }) {
  const d = {
    smooth: "M3 5c5 0.5 9 4 12 10",
    linear: "M3 5l12 10",
    scurve: "M3 5c5 0, 7 10, 12 10",
    exponential: "M3 5c1.5 6.5, 6 9.5, 12 10",
    logarithmic: "M3 5c6 1, 10.5 3.5, 12 10",
  }[curve];
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const formatSeconds = (value: number): string => `${Number(value.toFixed(2))}s`;

const formatDb = (value: number): string => `${value > 0 ? "+" : ""}${Number(value.toFixed(1))} dB`;

function trackLengthLabel(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MusicDrillIn({
  audio,
  onBack,
  onChooseTrack,
  onRemoveTrack,
  onPatch,
  onPreview,
}: {
  /** The loaded soundtrack (defaults applied); undefined = the project has no music yet. */
  audio: ProjectAudio | undefined;
  onBack: () => void;
  onChooseTrack: () => void;
  onRemoveTrack: () => void;
  /** Commit mix fields to project.json (the host owns the merge and history). */
  onPatch: (patch: Partial<ProjectAudioSpec>) => void;
  /** Live envelope while a slider drags; nothing writes. */
  onPreview: (patch: Partial<ProjectAudioSpec>) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  // The Remove confirmation disarms itself, the footer-delete pattern.
  useEffect(() => {
    if (!confirmRemove) return;
    const t = window.setTimeout(() => setConfirmRemove(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmRemove]);

  const fadeOutMs = audio?.fadeOutMs ?? DEFAULT_AUDIO_FADE_OUT_MS;
  const activeCurve = audio?.fadeOutCurve ?? "smooth";

  return (
    <div className="inspector-drill">
      <DrillBack label="Project" title="Music" onClick={onBack} />
      <div className="inspector-drill-body">
        <DrillGroup label="Track">
          <div className="device-editor-media-summary">
            <div className="device-editor-media-thumb">
              <MusicControlIcon type="track" />
            </div>
            <div className="device-editor-media-copy">
              <span
                className="device-editor-media-name"
                title={audio ? audio.file.split("/").pop() : undefined}
              >
                {audio ? audio.file.split("/").pop() : "No music yet"}
              </span>
              <span className="device-editor-media-detail">
                {audio
                  ? trackLengthLabel(audio.durationMs)
                  : "One soundtrack plays across the whole video."}
              </span>
            </div>
          </div>
          <div className="device-editor-media-actions">
            <button type="button" className="btn" onClick={onChooseTrack}>
              <MusicControlIcon type="track" />
              {audio ? "Replace" : "Choose track"}
            </button>
            {audio && (
              <button
                type="button"
                className={`btn${confirmRemove ? " danger" : ""}`}
                onClick={() => {
                  if (!confirmRemove) {
                    setConfirmRemove(true);
                    return;
                  }
                  setConfirmRemove(false);
                  onRemoveTrack();
                }}
              >
                <SceneMenuIcon id="delete" />
                {confirmRemove ? "Really remove?" : "Remove"}
              </button>
            )}
          </div>
        </DrillGroup>

        {audio && (
          <>
            <DrillGroup label="Mix">
              <InspectorSliderRow
                icon={<MusicControlIcon type="volume" />}
                label="Volume"
                value={audio.gainDb ?? 0}
                min={-24}
                max={12}
                step={0.5}
                formatValue={formatDb}
                onInput={(value) => onPreview({ gainDb: value })}
                onCommit={(value) => onPatch({ gainDb: value })}
              />
              <InspectorSliderRow
                icon={<MusicControlIcon type="offset" />}
                label="Start offset"
                value={(audio.startOffsetMs ?? 0) / 1000}
                min={0}
                max={60}
                step={0.1}
                overflowMax
                formatValue={formatSeconds}
                onInput={(value) => onPreview({ startOffsetMs: Math.round(value * 1000) })}
                onCommit={(value) => onPatch({ startOffsetMs: Math.round(value * 1000) })}
              />
            </DrillGroup>

            <DrillGroup label="Fades">
              <InspectorSliderRow
                icon={<MusicControlIcon type="fadein" />}
                label="Fade in"
                value={(audio.fadeInMs ?? 0) / 1000}
                min={0}
                max={10}
                step={0.1}
                overflowMax
                formatValue={formatSeconds}
                onInput={(value) => onPreview({ fadeInMs: Math.round(value * 1000) })}
                onCommit={(value) => onPatch({ fadeInMs: Math.round(value * 1000) })}
              />
              <InspectorSliderRow
                icon={<MusicControlIcon type="fadeout" />}
                label="Fade out"
                value={fadeOutMs / 1000}
                min={0}
                max={10}
                step={0.1}
                overflowMax
                formatValue={formatSeconds}
                onInput={(value) => onPreview({ fadeOutMs: Math.round(value * 1000) })}
                onCommit={(value) => onPatch({ fadeOutMs: Math.round(value * 1000) })}
              />
              <fieldset
                className="wizard-presets music-fade-curves"
                aria-label="Fade out type"
                disabled={fadeOutMs === 0}
              >
                {AUDIO_FADE_CURVES.map((curve) => (
                  <button
                    key={curve}
                    type="button"
                    className={`chip${activeCurve === curve ? " selected" : ""}`}
                    aria-pressed={activeCurve === curve}
                    onClick={() => onPatch({ fadeOutCurve: curve })}
                  >
                    <CurveIcon curve={curve} />
                    {CURVE_LABELS[curve]}
                  </button>
                ))}
              </fieldset>
              <p className="modal-hint">
                The fade lands where the music actually ends: the end of the track, or the end of
                the video when the track outlasts it.
              </p>
            </DrillGroup>
          </>
        )}
      </div>
    </div>
  );
}
