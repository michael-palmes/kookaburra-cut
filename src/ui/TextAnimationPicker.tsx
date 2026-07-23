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

/** Text-motion panel: an inline picker in the Text drill, no GL preview because the real stage IS the preview; every pick patches `doc.textAnimation` immediately as one undo. */

/** Slider that live-updates its label but commits debounced (the ColourInput pattern); a sidecar write per drag tick would thrash the JSON file. Shared with the Background editor's Animated tab. With `onInput`, the debounced ticks are live (history-less) writes and `onCommit` fires once on release, so a drag reads as ONE undo step. */
export function DebouncedRange({
  value,
  min,
  max,
  step,
  label,
  onCommit,
  onInput,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onCommit: (v: number) => void;
  /** When present, the drag's debounced ticks call this (live, history-less) and `onCommit` fires only on release. */
  onInput?: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const pending = useRef<number | null>(null);
  const latest = useRef(value);
  const dragValue = useRef(value);
  const dragged = useRef(false);
  const cancel = useRef(false);
  const editRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setV(value);
    latest.current = value;
  }, [value]);
  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      editRef.current?.select();
    }
  }, [editing]);
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );
  function schedule(next: number) {
    setV(next);
    dragValue.current = next;
    if (onInput) dragged.current = true;
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(
      () => {
        pending.current = null;
        if (next !== latest.current) {
          latest.current = next;
          (onInput ?? onCommit)(next);
        }
      },
      onInput ? 120 : 300,
    );
  }
  // Release ends a drag: flush the pending live tick and record ONE history commit.
  function release() {
    if (!onInput || !dragged.current) return;
    dragged.current = false;
    if (pending.current !== null) {
      window.clearTimeout(pending.current);
      pending.current = null;
    }
    onCommit(dragValue.current);
  }
  // Double-click the number to type a value: clamps to [min, max] but keeps the typed precision.
  function finishEdit(commit: boolean) {
    setEditing(false);
    if (!commit) return;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max, Math.max(min, parsed));
    if (pending.current !== null) {
      window.clearTimeout(pending.current);
      pending.current = null;
    }
    setV(clamped);
    if (clamped !== latest.current) {
      latest.current = clamped;
      onCommit(clamped);
    }
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
        onPointerUp={release}
        onKeyUp={release}
      />
      {editing ? (
        <input
          ref={editRef}
          className="range-value range-value-edit"
          value={text}
          inputMode="decimal"
          aria-label={`${label} value`}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const commit = !cancel.current;
            cancel.current = false;
            finishEdit(commit);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              cancel.current = false;
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              cancel.current = true;
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="range-value"
          title="Double-click to type a value"
          onDoubleClick={() => {
            setText(v.toFixed(2));
            setEditing(true);
          }}
        >
          {v.toFixed(2)}
        </button>
      )}
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
}: {
  /** The sidecar's spec at open (undefined = following the theme). */
  current: TextAnimationSpec | undefined;
  /** The scene's resolved theme; names the Theme-default chip's motion. */
  theme: Theme | undefined;
  /** The scene has text elements with explicit TSX animation props (live registry); after a pick, offer the override instead of losing it silently. */
  codedMotion: boolean;
  /** The sidecar's `textAnimationForce` right now. */
  force: boolean;
  /** Patch `doc.textAnimation` (undefined clears the override); each pick is one undo. */
  onLive: (spec: TextAnimationSpec | undefined) => void;
  /** Patch `doc.textAnimationForce`; the coded-motion override. */
  onForce: (on: boolean) => void;
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
            <button type="button" className="btn btn-small" onClick={() => onForce(false)}>
              Undo override
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
