import { useEffect, useState } from "react";
import { listProjects, PROJECT_TEMPLATES, slugifyName } from "../engine/workspace";
import { listThemeChoices, type ThemeChoice, ThemeGrid } from "./ThemePicker";
import { useEscapeClose } from "./useEscapeClose";

/** Setup-failure escape hatch, never seen on a healthy first run: the workspace is created silently at ~/Kookaburra Cut and only ever moved from Settings. This appears when that creation failed (unwritable home folder, full disk), so a blocked default is recoverable without a reinstall. (Default moved out of ~/Documents 2026-07-05: macOS TCC guards Documents and kept breaking headless gates and terminal-driven workflows.) */
export function SetupFailedDialog({
  error,
  onRetry,
  onChoose,
}: {
  error: string;
  onRetry: () => Promise<void>;
  onChoose: () => Promise<void>;
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
          pick somewhere else to keep your projects.
        </p>
        <p className="modal-error">{retryError ?? error}</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={run(onChoose)} disabled={busy}>
            Choose folder…
          </button>
          <button type="button" className="btn primary" onClick={run(onRetry)} disabled={busy}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/** F-001 trust gate: consent before a workspace project's scene code compiles. Escape declines, same as Don't open. */
export function TrustGateModal({
  name,
  onAnswer,
}: {
  name: string;
  onAnswer: (allowed: boolean) => void;
}) {
  useEscapeClose(() => onAnswer(false));
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Allow project ${name}?`}
    >
      <div className="modal">
        <h2>This project runs scene code on your Mac</h2>
        <p className="muted">
          Scenes in “{name}” are code that compiles and runs inside Kookaburra Cut, with the same
          access as the app itself. Only allow projects you trust.
        </p>
        <p className="muted">
          Your own edits stay trusted. If the project changes outside the app, you will be asked
          again. Allowing is consent, not a sandbox.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onAnswer(false)}>
            Don't open
          </button>
          <button type="button" className="btn primary" onClick={() => onAnswer(true)}>
            Allow project
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

/** Create-project dialog: name + template, then the theme grid with hover-cycled previews. The theme applies to the new project's `project.json` after the template copy (`set_project_theme`). */
export function NewProjectDialog({
  initialGroup,
  onCreate,
  onCancel,
}: {
  /** Preselected welcome-screen group (from a group heading's "+"). */
  initialGroup?: string | null;
  onCreate: (
    name: string,
    templateId: string,
    themeId: string,
    group: string | null,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"details" | "theme">("details");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>(PROJECT_TEMPLATES[0].id);
  const [themeId, setThemeId] = useState("kookaburra-studio-white");
  const [themes, setThemes] = useState<ThemeChoice[]>([]);
  const [group, setGroup] = useState(initialGroup ?? "");
  const [groups, setGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = slugifyName(name);
  useEscapeClose(onCancel, !busy);
  // Bundled choices resolve synchronously inside; workspace themes join when listed.
  useEffect(() => {
    let cancelled = false;
    void listThemeChoices().then((choices) => {
      if (!cancelled) setThemes(choices);
    });
    void listProjects()
      .then((list) => {
        if (cancelled) return;
        const names = Array.from(
          new Set(list.map((p) => p.group).filter((g): g is string => Boolean(g))),
        ).sort((a, b) => a.localeCompare(b));
        setGroups(names);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const next = () => {
    if (!slug) {
      setError("Give the project a name.");
      return;
    }
    setError(null);
    setStep("theme");
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, templateId, themeId, group.trim() || null);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="New project">
      <div className={`modal${step === "theme" ? " wizard-wide" : ""}`}>
        <h2>New project</h2>
        {step === "details" && (
          <>
            <input
              className="modal-input"
              type="text"
              placeholder="Project name"
              value={name}
              // biome-ignore lint/a11y/noAutofocus: the dialog exists solely to type a name
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") next();
              }}
            />
            <p className="modal-hint">
              {slug ? `Saved as ${slug}` : "Pick a template, then name your project."}
            </p>
            <fieldset className="template-grid" aria-label="Starting template">
              {PROJECT_TEMPLATES.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  aria-pressed={templateId === t.id}
                  className={`template-option${templateId === t.id ? " selected" : ""}`}
                  onClick={() => setTemplateId(t.id)}
                >
                  <img src={t.thumb} alt="" />
                  <span>{t.name}</span>
                </button>
              ))}
            </fieldset>
            <div className="wizard-field">
              <span className="wizard-label">Group (optional)</span>
              {groups.length > 0 && (
                <fieldset className="group-chips" aria-label="Existing groups">
                  {groups.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={`group-chip${group.trim() === g ? " selected" : ""}`}
                      onClick={() => setGroup(group.trim() === g ? "" : g)}
                    >
                      {g}
                    </button>
                  ))}
                </fieldset>
              )}
              <input
                className="modal-input"
                type="text"
                placeholder="No group"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              />
            </div>
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={next} disabled={busy}>
                Next
              </button>
            </div>
          </>
        )}
        {step === "theme" && (
          <>
            <p className="modal-hint">
              Pick the project's theme — hover a card to preview its four scenes. You can change it
              later, per project or per scene.
            </p>
            <ThemeGrid choices={themes} value={themeId} onChange={setThemeId} />
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setStep("details")}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
