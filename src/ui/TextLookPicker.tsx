import { useRef, useState } from "react";
import { optionPreviewClip, optionPreviewStill } from "../engine/optionPreviews";
import type { TextLookSpec, Theme } from "../theme/tokens";
import type { TextLookName } from "../toolkit/text/looks";
import { ColourPicker } from "./colour/ColourPicker";
import { OptionCard } from "./OptionCard";
import { DebouncedRange } from "./TextAnimationPicker";
import {
  darkenedStopB,
  defaultLookDraft,
  describeLookSpec,
  lookDraftToSpec,
  lookSpecToDraft,
  TEXT_LOOK_CATALOG,
  type TextLookDraft,
  textLookMeta,
} from "./textLookOptions";

/** Text-style panel (the "text look" catalogue): an inline picker mirroring TextMotionPanel, no GL preview because the real stage IS the preview; every pick patches `doc.textLook` immediately as one undo. Preview clips are the committed `textlook-<preset>` option-preview sets; until they render, cards fall back to the look's line glyph. */

/** Line glyph per look; the card fallback tile and the drill's preset icons (icons-by-default). */
export function TextLookIcon({ look, size = 16 }: { look: TextLookName | "theme"; size?: number }) {
  const glyph =
    look === "theme" ? (
      <path d="M8 2.5s4 4.2 4 7a4 4 0 0 1-8 0c0-2.8 4-7 4-7z" />
    ) : look === "gradient" ? (
      <>
        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
        <path d="M6 3.5v9" opacity="0.85" />
        <path d="M8.5 3.5v9" opacity="0.55" />
        <path d="M11 3.5v9" opacity="0.3" />
      </>
    ) : look === "outline" ? (
      <>
        <path d="M3.5 12.5 8 3l4.5 9.5" />
        <path d="M5.4 9.2h5.2" />
      </>
    ) : look === "neon" ? (
      <>
        <path d="M5 11.5 8 5l3 6.5" />
        <path d="M2.5 13.5a7.5 7.5 0 0 1 0-11M13.5 2.5a7.5 7.5 0 0 1 0 11" opacity="0.55" />
      </>
    ) : look === "offset-print" ? (
      <>
        <rect x="2.5" y="2.5" width="8.5" height="8.5" rx="1" />
        <path d="M13.5 6v6.5a1 1 0 0 1-1 1H6" opacity="0.55" />
      </>
    ) : look === "highlight-block" ? (
      <>
        <rect
          x="2.5"
          y="5"
          width="11"
          height="6"
          rx="1"
          fill="currentColor"
          opacity="0.28"
          stroke="none"
        />
        <path d="M4.5 8h7" />
      </>
    ) : look === "frosted" ? (
      <>
        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
        <path d="m5 12.5 5-9M8.5 12.5l3-5.5" opacity="0.55" />
      </>
    ) : look === "arc" ? (
      <>
        <path d="M2.5 11.5a6.5 6.5 0 0 1 11 0" />
        <path d="M2.5 11.5v2M13.5 11.5v2M8 5v2" />
      </>
    ) : look === "glass-3d" ? (
      <>
        <path d="m8 1.8 5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z" />
        <path d="M8 8V14.2M8 8 2.6 4.9M8 8l5.4-3.1" opacity="0.5" />
      </>
    ) : look === "chrome-3d" ? (
      <>
        <path d="m8 1.8 5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z" />
        <path d="M12.6 3.2l1.6-1.6M13.4 6.4l1.8-.5" opacity="0.7" />
      </>
    ) : (
      <path d="M4 13 8 3l4 10M5.5 9.5h5" />
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

export function TextLookPanel({
  current,
  theme,
  codedLook,
  force,
  onLive,
  onForce,
}: {
  /** The sidecar's spec at open (undefined = following the theme). */
  current: TextLookSpec | undefined;
  /** The scene's resolved theme; names the Theme-default chip's look and the colour fallbacks. */
  theme: Theme | undefined;
  /** The scene has text elements with explicit TSX look props (live registry); after a pick, offer the override instead of losing it silently. */
  codedLook: boolean;
  /** The sidecar's `textLookForce` right now. */
  force: boolean;
  /** Patch `doc.textLook` (undefined clears the override); each pick is one undo. */
  onLive: (spec: TextLookSpec | undefined) => void;
  /** Patch `doc.textLookForce`; the coded-look override. */
  onForce: (on: boolean) => void;
}) {
  const [draft, setDraft] = useState<TextLookDraft | null>(() =>
    current ? lookSpecToDraft(current) : null,
  );
  const meta = draft ? textLookMeta(draft.preset) : undefined;
  // The pick always lands (non-blocking); the override question rides after it, once per panel open unless the user said "keep the code".
  const [askOverride, setAskOverride] = useState(false);
  const overrideDismissed = useRef(false);

  function commit(next: TextLookDraft | null) {
    setDraft(next);
    onLive(next ? lookDraftToSpec(next) : undefined);
    if (codedLook && !force && !overrideDismissed.current) setAskOverride(true);
  }

  // Preview-card hover: the hovered card plays its clip, the selected one loops; "theme" stands in for the Theme-default card.
  const [hoverCard, setHoverCard] = useState<string | null>(null);
  const themePreset = theme?.textLook?.preset ?? "none";
  const accent = theme?.colors.accent ?? "#4da3ff";
  const colourADefault = meta?.colorADefault ?? accent;
  const colourALabel = meta?.colorALabel ?? "Colour";
  const colourA = draft?.colorA ?? colourADefault;
  const colourB = draft?.colorB ?? darkenedStopB(colourA);

  const card = (preset: TextLookDraft["preset"] | "theme", label: string, hint: string) => {
    const set = `textlook-${preset === "theme" ? themePreset : preset}`;
    const preview = optionPreviewClip(set);
    const still = optionPreviewStill(set);
    const selected = preset === "theme" ? draft === null : draft?.preset === preset;
    return (
      <OptionCard
        key={preset}
        label={label}
        title={hint}
        image={preview?.poster ?? still}
        icon={
          preview || still ? undefined : (
            <TextLookIcon look={preset === "theme" ? "theme" : preset} size={24} />
          )
        }
        clip={preview?.clip}
        playing={hoverCard === preset || selected}
        selected={selected}
        onSelect={() =>
          commit(
            preset === "theme" ? null : draft ? { ...draft, preset } : defaultLookDraft(preset),
          )
        }
        onHoverChange={(h) => setHoverCard((cur) => (h ? preset : cur === preset ? null : cur))}
      />
    );
  };

  return (
    <div className="text-motion-panel text-look-panel" role="menu" aria-label="Text style">
      <span className="wizard-label">Text style</span>
      <div className="option-grid three-up" role="listbox" aria-label="Text style preset">
        {card("theme", "Theme default", describeLookSpec(theme?.textLook))}
        {TEXT_LOOK_CATALOG.map((m) => card(m.preset, m.label, m.hint))}
      </div>

      {draft && (meta?.hasColorA || meta?.hasColorB) && (
        <div className="popover-row">
          <span className="popover-group-label">Colours</span>
          {meta?.hasColorA && (
            <span className="popover-inline">
              {colourALabel}
              <ColourPicker
                value={colourA}
                defaultValue={colourADefault}
                label={`Style ${colourALabel.toLowerCase()}`}
                theme={theme}
                onCommit={(hex) => commit({ ...draft, colorA: hex })}
                onReset={draft.colorA ? () => commit({ ...draft, colorA: null }) : undefined}
              />
            </span>
          )}
          {meta?.hasColorB && (
            <span className="popover-inline">
              Stop B
              <ColourPicker
                value={colourB}
                defaultValue={darkenedStopB(colourA)}
                label="Gradient stop B"
                theme={theme}
                onCommit={(hex) => commit({ ...draft, colorB: hex })}
                onReset={draft.colorB ? () => commit({ ...draft, colorB: null }) : undefined}
              />
            </span>
          )}
        </div>
      )}

      {draft &&
        (meta?.hasAngle ||
          meta?.hasStroke ||
          meta?.hasHollow ||
          meta?.hasIntensity ||
          meta?.hasOffset ||
          meta?.hasCurve) && (
          <div className="popover-row">
            <span className="popover-group-label">Params</span>
            {meta?.hasAngle && (
              <>
                <span className="popover-inline">Angle</span>
                <DebouncedRange
                  value={draft.angleDeg}
                  min={0}
                  max={360}
                  step={5}
                  label="Gradient angle"
                  onCommit={(angleDeg) => commit({ ...draft, angleDeg })}
                />
              </>
            )}
            {meta?.hasStroke && (
              <>
                <span className="popover-inline">Stroke</span>
                <DebouncedRange
                  value={draft.strokeEm}
                  min={0.005}
                  max={0.12}
                  step={0.005}
                  label="Outline stroke width"
                  onCommit={(strokeEm) => commit({ ...draft, strokeEm })}
                />
              </>
            )}
            {meta?.hasHollow && (
              <label className="popover-inline" title="Hide the fill and keep only the stroke">
                <input
                  type="checkbox"
                  checked={draft.hollow}
                  onChange={(e) => commit({ ...draft, hollow: e.target.checked })}
                />
                Hollow
              </label>
            )}
            {meta?.hasIntensity && (
              <>
                <span className="popover-inline">Intensity</span>
                <DebouncedRange
                  value={draft.intensity}
                  min={0}
                  max={1}
                  step={0.05}
                  label="Style intensity"
                  onCommit={(intensity) => commit({ ...draft, intensity })}
                />
              </>
            )}
            {meta?.hasOffset && (
              <>
                <span className="popover-inline">Offset</span>
                <DebouncedRange
                  value={draft.offsetEm}
                  min={0}
                  max={0.2}
                  step={0.005}
                  label="Offset-print displacement"
                  onCommit={(offsetEm) => commit({ ...draft, offsetEm })}
                />
              </>
            )}
            {meta?.hasCurve && (
              <>
                <span className="popover-inline">Curve</span>
                <DebouncedRange
                  value={draft.curveDeg}
                  min={-180}
                  max={180}
                  step={5}
                  label="Arc bend"
                  onCommit={(curveDeg) => commit({ ...draft, curveDeg })}
                />
              </>
            )}
          </div>
        )}

      {askOverride && (
        <div className="popover-row">
          <span className="popover-group-label" />
          <span className="popover-blurb">
            Some text in this scene sets its own style, so your pick may not show there.
          </span>
          <span className="popover-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                overrideDismissed.current = true;
                setAskOverride(false);
              }}
            >
              Leave it
            </button>
            <button
              type="button"
              className="btn btn-small primary"
              onClick={() => {
                setAskOverride(false);
                onForce(true);
              }}
            >
              Override
            </button>
          </span>
        </div>
      )}
      {force && !askOverride && (
        <div className="popover-row">
          <span className="popover-group-label" />
          <span className="popover-blurb">Overriding this scene's built-in text style.</span>
          <span className="popover-actions">
            <button type="button" className="btn btn-small" onClick={() => onForce(false)}>
              Undo override
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
