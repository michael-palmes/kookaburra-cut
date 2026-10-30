import { useState } from "react";
import { useEscapeClose } from "./useEscapeClose";

/** Setup-failure escape hatch, never seen on a healthy first run: the workspace is created silently at ~/Kookaburra Cut and only ever placed or moved from Settings, the one window that may pick a folder (behind a native confirmation). This appears when that creation failed (unwritable home folder, full disk), so a blocked default is recoverable without a reinstall. (Default moved out of ~/Documents 2026-07-05: macOS TCC guards Documents and kept breaking headless gates and terminal-driven workflows.) */
export function SetupFailedDialog({
  error,
  onRetry,
  onOpenSettings,
}: {
  error: string;
  onRetry: () => Promise<void>;
  onOpenSettings: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    setRetryError(null);
    try {
      await action();
    } catch (e) {
      setRetryError(String(e));
      setBusy(false);
    }
  };
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Set up Kookaburra Cut"
    >
      <div className="modal">
        <h2>Kookaburra Cut could not set up your projects folder</h2>
        <p className="muted">
          It tried to create a <code>Kookaburra Cut</code> folder in your home folder. Try again, or
          choose another folder for your projects in Settings.
        </p>
        <p className="modal-error">{retryError ?? error}</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={run(onOpenSettings)} disabled={busy}>
            Open Settings…
          </button>
          <button type="button" className="btn primary" onClick={run(onRetry)} disabled={busy}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/** Plain-English warning before the camera switches to Free, shown until the user ticks it away. Escape is Cancel, and the tick only sticks when the switch is confirmed. */
export function FreeCameraWarningModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (dontShowAgain: boolean) => void;
  onCancel: () => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  useEscapeClose(onCancel);
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Switch to Free camera?"
    >
      <div className="modal">
        <h2>Switch to Free camera?</h2>
        <p className="muted">
          Free mode unlocks the camera so you can fly it anywhere, like piloting a drone: you choose
          where it sits and where it looks. It is more powerful than Orbit, but it is easier to lose
          your framing.
        </p>
        <p className="muted">Your Orbit settings are kept, so you can switch back at any time.</p>
        <label className="modal-check">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => onConfirm(dontShowAgain)}>
            Switch to Free
          </button>
        </div>
      </div>
    </div>
  );
}
