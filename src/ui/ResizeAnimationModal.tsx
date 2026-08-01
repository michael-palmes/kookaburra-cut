import { useEffect, useRef, useState } from "react";
import type { ResizeBounds } from "../engine/keyedTrack";
import { NumberField } from "./inspector/rows";
import { useEscapeClose } from "./useEscapeClose";

/** Type one animation's length in seconds (the lane's Resize… item). The resize ripples, so every later keyframe shifts by the same delta and the chain survives, which is how four animations end up exactly 0.5s each. */
export function ResizeAnimationModal({
  bounds,
  onCommit,
  onCancel,
}: {
  bounds: ResizeBounds;
  /** The new span in ms; the engine re-clamps to the same bounds. */
  onCommit: (spanMs: number) => void;
  onCancel: () => void;
}) {
  const [seconds, setSeconds] = useState(bounds.spanMs / 1000);
  // Enter commits the field's live text before the modal reads it, so one keystroke is enough.
  const latest = useRef(seconds);
  const fieldRef = useRef<HTMLDivElement>(null);
  useEscapeClose(onCancel);

  useEffect(() => {
    const input = fieldRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, []);

  const set = (value: number) => {
    latest.current = value;
    setSeconds(value);
  };
  const submit = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    onCommit(Math.round(latest.current * 1000));
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Resize animation"
      onKeyDown={(e) => {
        // Enter on a button is that button's own activation, never a submit.
        if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") submit();
      }}
    >
      <div className="modal">
        <h2>Resize animation</h2>
        <div className="resize-anim-field" ref={fieldRef}>
          <NumberField
            label="seconds"
            value={seconds}
            decimals={2}
            step={0.1}
            min={bounds.minMs / 1000}
            max={bounds.maxMs / 1000}
            onCommit={set}
          />
        </div>
        <p className="modal-hint">
          {`Between ${(bounds.minMs / 1000).toFixed(2)}s and ${(bounds.maxMs / 1000).toFixed(2)}s. Later keyframes shift with it, so the chain stays intact.`}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit}>
            Resize
          </button>
        </div>
      </div>
    </div>
  );
}
