import banner from "../assets/update-banner.jpg";
import { useEscapeClose } from "./useEscapeClose";

/** The update lane's two modals, in their own module so the Settings window can import them without dragging in dialogs.tsx's theme-picker graph (40 bundled preview images). Both share the moonlit-kookaburra banner (chrome-only imagery; exported pixels never touch the DOM). */

/** One-time update-check consent ask (shown while the tri-state preference is undecided). Escape answers Not now, same as the trust gate; either answer settles it and the ask never repeats. */
export function UpdateConsentDialog({ onAnswer }: { onAnswer: (on: boolean) => void }) {
  useEscapeClose(() => onAnswer(false));
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Check for updates on launch?"
    >
      <div className="modal modal-with-banner">
        <img className="modal-banner" src={banner} alt="" />
        <h2>Check for updates on launch?</h2>
        <p className="muted">
          Kookaburra Cut can ask GitHub when it starts whether a newer release exists.
        </p>
        <ul className="muted modal-list">
          <li>Sends no identifiers and nothing about your usage</li>
          <li>GitHub sees only an ordinary web request</li>
          <li>Nothing downloads or installs without your say-so</li>
        </ul>
        <p className="muted">Change this any time in Settings.</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onAnswer(false)}>
            Not now
          </button>
          <button type="button" className="btn primary" onClick={() => onAnswer(true)}>
            Enable (recommended)
          </button>
        </div>
      </div>
    </div>
  );
}

/** A newer release is ready: install in place and relaunch, or decline (Later also remembers the version so it isn't re-offered every launch). */
export function UpdateAvailableDialog({
  version,
  notes,
  installing,
  installError,
  onLater,
  onInstall,
}: {
  version: string;
  notes: string | null;
  installing: boolean;
  installError: string | null;
  onLater: () => void;
  onInstall: () => void;
}) {
  useEscapeClose(onLater, !installing);
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Kookaburra Cut ${version} is available`}
    >
      <div className="modal modal-with-banner">
        <img className="modal-banner" src={banner} alt="" />
        <h2>Kookaburra Cut {version} is available</h2>
        <p className="muted">
          Installing downloads the release, verifies its signature and relaunches the app.
        </p>
        {notes && <p className="muted update-notes">{notes}</p>}
        {installError && <p className="modal-error">{installError}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onLater} disabled={installing}>
            Later
          </button>
          <button type="button" className="btn primary" onClick={onInstall} disabled={installing}>
            {installing ? "Installing…" : "Install and relaunch"}
          </button>
        </div>
      </div>
    </div>
  );
}
