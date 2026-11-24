import banner from "../assets/update-banner.jpg";
import { useEscapeClose } from "./useEscapeClose";

/** The update offer, in its own module so the Settings window can import it without dragging in NewProjectDialog.tsx's theme-picker graph (40 bundled preview images). It shares the printed kookaburra banner with the setup dialog (chrome-only imagery; exported pixels never touch the DOM). */

/** A newer release is ready: install in place and relaunch, or Later, which hides it until the next due check offers it again. */
export function UpdateAvailableDialog({
  version,
  installing,
  installError,
  onLater,
  onInstall,
}: {
  version: string;
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
