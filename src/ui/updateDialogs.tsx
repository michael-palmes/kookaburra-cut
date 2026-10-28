import { useState } from "react";
import banner from "../assets/update-banner.jpg";
import { ManagedLock } from "./ManagedLock";
import { useEscapeClose } from "./useEscapeClose";

/** The update lane's two modals, in their own module so the Settings window can import them without dragging in NewProjectDialog.tsx's theme-picker graph (40 bundled preview images). Both share the moonlit-kookaburra banner (chrome-only imagery; exported pixels never touch the DOM). */

/** First-launch welcome, which carries the one-time update-check ask (shown while the tri-state preference is undecided). The switch starts on as the recommendation and Get started saves what it shows; Escape is a dismissal, not consent, so it saves off. Either answer settles it and the ask never repeats. Where a profile turns update checks off, the row says so in place of the switch and Get started saves off. */
export function WelcomeDialog({
  onAnswer,
  updatesManaged = false,
}: {
  onAnswer: (on: boolean) => void;
  updatesManaged?: boolean;
}) {
  const [checkUpdates, setCheckUpdates] = useState(!updatesManaged);
  useEscapeClose(() => onAnswer(false));
  // The row is a label for the switch; with the switch gone it is plain text.
  const Row = updatesManaged ? "div" : "label";
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Kookaburra Cut"
    >
      <div className="modal modal-with-banner welcome-modal">
        <img className="modal-banner" src={banner} alt="" />
        <div className="welcome-modal-intro">
          <h2>Welcome to Kookaburra Cut</h2>
          <p className="muted">Make polished product videos, right here on your Mac.</p>
        </div>
        <Row className="settings-row welcome-modal-update">
          <svg
            className="welcome-modal-update-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
            <path d="M19.5 4v4h-4" />
          </svg>
          <span className="settings-row-text">
            <span className="settings-row-title welcome-modal-update-title">
              Check for updates
              {!updatesManaged && <span className="recommended-badge">Recommended</span>}
            </span>
            <span className="settings-row-detail muted">
              {updatesManaged
                ? "Turned off by your organisation's configuration profile."
                : "An anonymous check with GitHub. Nothing installs without asking."}
            </span>
          </span>
          {updatesManaged ? (
            <ManagedLock />
          ) : (
            <span className="toggle-switch">
              <input
                type="checkbox"
                role="switch"
                aria-checked={checkUpdates}
                checked={checkUpdates}
                onChange={(e) => setCheckUpdates(e.target.checked)}
              />
              <span className="toggle-switch-track" aria-hidden="true">
                <span className="toggle-switch-thumb" />
              </span>
            </span>
          )}
        </Row>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={() => onAnswer(checkUpdates)}>
            Get started
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
