import { useState } from "react";
import banner from "../assets/update-banner.jpg";
import { openPrivacyPage } from "../engine/claudeApp";
import { ClaudeSpark } from "./ClaudeLauncher";
import { LockGlyph, ManagedLock } from "./ManagedLock";
import { useEscapeClose } from "./useEscapeClose";

/** Why the Claude choice is not offered: a profile turned Claude off, or it asks for the organisation's Claude settings and they are not on this Mac. */
export type ClaudeChoiceLock = "managed" | "orgMissing";

/** Why the update switch is not offered: a profile turned checks off, or the copy came from the installer package. */
export type UpdatesLock = "managed" | "installer";

/** What the dialog asked and got; a part it did not ask stays null and nothing is stored for it. */
export interface SetupAnswer {
  claude: boolean | null;
  updates: boolean | null;
}

const LOCK_DETAIL: Record<ClaudeChoiceLock, string> = {
  managed: "Turned off by your organisation.",
  orgMissing: "Needs your organisation's Claude settings. Ask IT.",
};

function Icon({ d }: { d: string }) {
  return (
    <svg
      className="setup-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const MAC_ICON =
  "M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM8.5 20h7M12 16.5V20";
const UPDATE_ICON = "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4";
const COVERED_ICON = "M12 3.5 5 6v5.5c0 4.2 2.9 7.3 7 9 4.1-1.7 7-4.8 7-9V6zM9 12l2.2 2.2L15 10.4";

/** The first-launch setup, and the same choice reopened from the titlebar. Claude is a choice with nothing selected, so turning it on is a person's act and Get started waits for it; the update switch starts on as the recommendation. Escape on a first launch is a dismissal, not consent, so it saves off for whatever was asked; reopened, it changes nothing. A part a profile or the installer owns shows its lock in place of the control and is never stored. */
export function SetupDialog({
  onAnswer,
  onCancel,
  askClaude,
  askUpdates,
  claudeLock = null,
  claudeCovered = false,
  updatesLock = null,
  organisationServer = false,
}: {
  onAnswer: (answer: SetupAnswer) => void;
  /** Present when the dialog was reopened: Escape and Cancel close it without storing anything. */
  onCancel?: () => void;
  askClaude: boolean;
  askUpdates: boolean;
  claudeLock?: ClaudeChoiceLock | null;
  /** A profile asks for the organisation's Claude settings and they are on this Mac. */
  claudeCovered?: boolean;
  updatesLock?: UpdatesLock | null;
  /** A profile points update checks at the organisation's own server (UpdateEndpoint). */
  organisationServer?: boolean;
}) {
  const chooseClaude = askClaude && claudeLock === null;
  const chooseUpdates = askUpdates && updatesLock === null;
  const [claude, setClaude] = useState<boolean | null>(null);
  const [checkUpdates, setCheckUpdates] = useState(true);
  const reopened = onCancel !== undefined;
  const dismiss = () =>
    reopened
      ? onCancel()
      : onAnswer({ claude: chooseClaude ? false : null, updates: chooseUpdates ? false : null });
  useEscapeClose(dismiss);
  const title = reopened ? "Set up Claude" : "Welcome to Kookaburra Cut";
  const lead = chooseClaude
    ? "Pick how you want to work."
    : "Make polished product videos, right here on your Mac.";
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal modal-with-banner welcome-modal">
        <img className="modal-banner" src={banner} alt="" />
        <div className="welcome-modal-intro">
          <h2>{title}</h2>
          <p className="muted">{lead}</p>
        </div>
        {chooseClaude && (
          <fieldset className="setup-choices">
            <legend className="visually-hidden">How you want to work</legend>
            <label className="setup-choice">
              <input
                type="radio"
                name="setup-claude"
                checked={claude === true}
                onChange={() => setClaude(true)}
              />
              <span className="setup-choice-title">
                <span className="setup-choice-mark">
                  <ClaudeSpark size={16} />
                </span>
                With Claude
              </span>
              <span className="muted">
                Describe a change and Claude edits it. Your project goes to Anthropic.
              </span>
              {claudeCovered && (
                <span className="setup-choice-note">
                  <Icon d={COVERED_ICON} />
                  Covered by your organisation's Claude settings.
                </span>
              )}
            </label>
            <label className="setup-choice">
              <input
                type="radio"
                name="setup-claude"
                checked={claude === false}
                onChange={() => setClaude(false)}
              />
              <span className="setup-choice-title">
                <Icon d={MAC_ICON} />
                On this Mac only
              </span>
              <span className="muted">Edit by hand. Your projects stay on this Mac.</span>
            </label>
          </fieldset>
        )}
        {askClaude && claudeLock !== null && (
          <div className="settings-row setup-row">
            <span className="setup-choice-mark setup-choice-mark-off">
              <ClaudeSpark size={16} />
            </span>
            <span className="settings-row-text">
              <span className="settings-row-title">Edit with Claude</span>
              <span className="settings-row-detail muted">{LOCK_DETAIL[claudeLock]}</span>
            </span>
            {claudeLock === "managed" ? (
              <ManagedLock />
            ) : (
              <span className="managed-lock">
                <LockGlyph />
              </span>
            )}
          </div>
        )}
        {askUpdates && updatesLock === null && (
          <label className="settings-row setup-row setup-row-switch">
            <Icon d={UPDATE_ICON} />
            <span className="settings-row-text">
              <span className="settings-row-title">Check for updates</span>
              <span className="settings-row-detail muted">
                {`Anonymous, with ${organisationServer ? "your organisation's server" : "GitHub"}. Asks before installing.`}
              </span>
            </span>
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
          </label>
        )}
        {askUpdates && updatesLock !== null && (
          <div className="settings-row setup-row">
            <Icon d={UPDATE_ICON} />
            <span className="settings-row-text">
              <span className="settings-row-title">Updates</span>
              <span className="settings-row-detail muted">
                {updatesLock === "managed"
                  ? "Turned off by your organisation."
                  : "Delivered by the installer package."}
              </span>
            </span>
            {updatesLock === "managed" ? (
              <ManagedLock />
            ) : (
              <span className="managed-lock">
                <LockGlyph />
              </span>
            )}
          </div>
        )}
        <p className="muted welcome-modal-privacy">
          {chooseClaude && chooseUpdates
            ? "Change either in Settings. "
            : chooseClaude || chooseUpdates
              ? "Change this in Settings. "
              : ""}
          <button
            type="button"
            className="text-link"
            onClick={() => void openPrivacyPage().catch((e) => console.error(e))}
          >
            What leaves your Mac
          </button>
        </p>
        <div className="modal-actions">
          {reopened && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={chooseClaude && claude === null}
            onClick={() =>
              onAnswer({
                claude: chooseClaude ? claude : null,
                updates: chooseUpdates ? checkUpdates : null,
              })
            }
          >
            {reopened ? "Done" : "Get started"}
          </button>
        </div>
      </div>
    </div>
  );
}
