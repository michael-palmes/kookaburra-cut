import { useEffect, useRef, useState } from "react";
import { optionPreviewClip, optionPreviewStill } from "../engine/optionPreviews";
import type { TextAnimationSpec, Theme } from "../theme/tokens";
import { OptionCard } from "./OptionCard";
import {
  DELIVERY_DEFAULT_MS,
  DELIVERY_OPTIONS,
  defaultDraft,
  describeSpec,
  draftToSpec,
  specToDraft,
  TEXT_PRESET_CATALOG,
  type TextAnimationDraft,
} from "./textAnimationOptions";

/** Text-motion panel: a docked live picker above the edit bar, no GL preview and no modal scrim because the real stage IS the preview; every pick patches `doc.textAnimation` immediately and auto-replays the scene, Cancel restores the spec captured at open; wall-clock use is fine here since the edit bar is unmounted during export/autorun. */

/** Slider that live-updates its label but commits debounced (the ColourInput pattern); a sidecar write per drag tick would thrash the JSON file. Shared with the Background editor's Animated tab. */
export function DebouncedRange({
  value,
  min,
  max,
  step,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  const pending = useRef<number | null>(null);
  const latest = useRef(value);
  useEffect(() => {
    setV(value);
    latest.current = value;
  }, [value]);
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );
  function schedule(next: number) {
    setV(next);
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      if (next !== latest.current) {
        latest.current = next;
        onCommit(next);
      }
    }, 300);
  }
  return (
    <span className="popover-inline">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        aria-label={label}
        onChange={(e) => schedule(Number(e.target.value))}
      />
      {v.toFixed(2)}
    </span>
  );
}

export function TextMotionPanel({
  current,
  theme,
  codedMotion,
  force,
  onLive,
  onForce,
  onReplay,
  onCancel,
  onDone,
}: {
  /** The sidecar's spec at open (undefined = following the theme). */
  current: TextAnimationSpec | undefined;
  /** The scene's resolved theme; names the Theme-default chip's motion. */
  theme: Theme | undefined;
  /** The scene has text elements with explicit TSX animation props (live registry); after a pick, offer the override instead of losing it silently. */
  codedMotion: boolean;
  /** The sidecar's `textAnimationForce` right now. */
  force: boolean;
  /** Patch `doc.textAnimation` NOW (undefined clears the override). */
  onLive: (spec: TextAnimationSpec | undefined) => void;
  /** Patch `doc.textAnimationForce`; the coded-motion override. */
  onForce: (on: boolean) => void;
  /** Seek to the scene start and play its window once; the live preview. */
  onReplay: () => void;
  /** Restore the open-time spec + force flag and close. */
  onCancel: () => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<TextAnimationDraft | null>(() =>
    current ? specToDraft(current) : null,
  );
  const meta = draft ? TEXT_PRESET_CATALOG.find((m) => m.preset === draft.preset) : undefined;
  // The pick always lands (non-blocking); the override question rides after it, once per panel open unless the user said "keep the code".
  const [askOverride, setAskOverride] = useState(false);
  const overrideDismissed = useRef(false);

  function commit(next: TextAnimationDraft | null) {
    setDraft(next);
    onLive(next ? draftToSpec(next) : undefined);
    onReplay();
    if (codedMotion && !force && !overrideDismissed.current) setAskOverride(true);
  }

  // Preview-card hover: the hovered card plays its clip, the selected one loops; "theme" stands in for the Theme-default card.
  const [hoverCard, setHoverCard] = useState<string | null>(null);
  const themePreset = theme?.textAnimation?.in ?? "none";

  const msDefault = draft ? DELIVERY_DEFAULT_MS[draft.delivery] : 0;
  const [msText, setMsText] = useState(draft?.staggerMs?.toString() ?? "");
  // Re-seed the ms field when the delivery (and so its default) changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-seed
  useEffect(() => setMsText(draft?.staggerMs?.toString() ?? ""), [draft?.delivery]);
  const commitMs = () => {
    if (!draft) return;
    const trimmed = msText.trim();
    const n = Number(trimmed);
    const next =
      trimmed === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(Math.min(2000, n)) || null;
    setMsText(next?.toString() ?? "");
    if (next !== draft.staggerMs) commit({ ...draft, staggerMs: next });
  };

  return (
    <div className="text-motion-panel" role="menu" aria-label="Text motion">
      <div className="popover-row">
        <span className="popover-group-label">Motion</span>
      </div>
      <div className="option-grid three-up" role="listbox" aria-label="Text motion preset">
        {(() => {
          const themePreview = optionPreviewClip(`textanim-${themePreset}`);
          return (
            <OptionCard
              label="Theme default"
              title={describeSpec(theme?.textAnimation)}
              image={themePreview?.poster ?? optionPreviewStill(`textanim-${themePreset}`)}
              clip={themePreview?.clip}
              playing={hoverCard === "theme" || draft === null}
              selected={draft === null}
              onSelect={() => commit(null)}
              onHoverChange={(h) =>
                setHoverCard((cur) => (h ? "theme" : cur === "theme" ? null : cur))
              }
            />
          );
        })()}
        {TEXT_PRESET_CATALOG.map((m) => {
          const preview = optionPreviewClip(`textanim-${m.preset}`);
          return (
            <OptionCard
              key={m.preset}
              label={m.label}
              title={m.hint}
              image={preview?.poster ?? optionPreviewStill(`textanim-${m.preset}`)}
              clip={preview?.clip}
              playing={hoverCard === m.preset || draft?.preset === m.preset}
              selected={draft?.preset === m.preset}
              onSelect={() =>
                commit(draft ? { ...draft, preset: m.preset } : defaultDraft(m.preset))
              }
              onHoverChange={(h) =>
                setHoverCard((cur) => (h ? m.preset : cur === m.preset ? null : cur))
              }
            />
          );
        })}
      </div>

      {draft && draft.preset !== "none" && (
        <div className="popover-row">
          <span className="popover-group-label">Delivery</span>
          <div className="popover-chip-wrap">
            {DELIVERY_OPTIONS.map((o) => {
              const collapses = meta?.perCharacter && o.id === "all-at-once";
              return (
                <button
                  type="button"
                  role="menuitem"
                  key={o.id}
                  className={`chip${draft.delivery === o.id ? " selected" : ""}`}
                  disabled={collapses}
                  title={
                    collapses ? "All at once would collapse the per-character scatter" : undefined
                  }
                  onClick={() => commit({ ...draft, delivery: o.id, staggerMs: null })}
                >
                  {o.label}
                </button>
              );
            })}
            {draft.delivery !== "default" && draft.delivery !== "all-at-once" && (
              <span className="popover-inline">
                <input
                  className="modal-input seconds-input"
                  value={msText}
                  inputMode="numeric"
                  placeholder={String(msDefault)}
                  aria-label="Delay between units, milliseconds"
                  onChange={(e) => setMsText(e.target.value)}
                  onBlur={commitMs}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setMsText(draft.staggerMs?.toString() ?? "");
                  }}
                />
                ms
              </span>
            )}
          </div>
        </div>
      )}

      {draft && (meta?.hasScaleParams || meta?.hasDirection) && (
        <div className="popover-row">
          <span className="popover-group-label">Params</span>
          {meta?.hasScaleParams && (
            <>
              <span className="popover-inline">Start scale</span>
              <DebouncedRange
                value={draft.startScale}
                min={0.5}
                max={1.5}
                step={0.05}
                label="Starting scale"
                onCommit={(v) => commit({ ...draft, startScale: v })}
              />
              <label className="popover-inline">
                <input
                  type="checkbox"
                  checked={draft.shine}
                  onChange={(e) => commit({ ...draft, shine: e.target.checked })}
                />
                Shine
              </label>
            </>
          )}
          {meta?.hasDirection &&
            (["from-left", "from-right"] as const).map((d) => (
              <button
                type="button"
                role="menuitem"
                key={d}
                className={`chip${draft.direction === d ? " selected" : ""}`}
                onClick={() => commit({ ...draft, direction: d })}
              >
                {d === "from-left" ? "From left" : "From right"}
              </button>
            ))}
        </div>
      )}

      {askOverride && (
        <div className="popover-row">
          <span className="popover-group-label" />
          <span className="popover-blurb">
            Some text in this scene sets its own motion, so your pick may not show there.
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
                onReplay();
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
          <span className="popover-blurb">Overriding this scene's built-in text motion.</span>
          <span className="popover-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                onForce(false);
                onReplay();
              }}
            >
              Undo override
            </button>
          </span>
        </div>
      )}

      <div className="popover-row">
        <span className="popover-group-label" />
        <span className="popover-actions">
          <button type="button" className="btn btn-small" onClick={onReplay}>
            ↺ Replay
          </button>
          <button type="button" className="btn btn-small" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-small primary" onClick={onDone}>
            Done
          </button>
        </span>
      </div>
    </div>
  );
}
