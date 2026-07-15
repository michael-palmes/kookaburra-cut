import { useState } from "react";
import { useEscapeClose } from "./useEscapeClose";

/** Small shared name-prompt modal: rename/duplicate a project, rename an asset. The submit handler is async, its rejection renders inline and the modal stays open for another try; Escape/Cancel are disabled while it runs. */
export function NamePromptModal({
  title,
  label,
  initial,
  submitLabel,
  hint,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  hint?: string;
  /** Resolve = done (the host closes); reject = shown inline, modal stays open. */
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(onCancel, !busy);

  const submit = () => {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    onSubmit(value.trim()).catch((e) => {
      setError(String(e));
      setBusy(false);
    });
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h2>{title}</h2>
        <div className="wizard-field">
          <span className="wizard-label">{label}</span>
          <input
            className="modal-input"
            value={value}
            // biome-ignore lint/a11y/noAutofocus: a single-input prompt IS the focus target
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        {hint && <p className="modal-hint">{hint}</p>}
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={busy || !value.trim()}
          >
            {busy ? "Working…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
