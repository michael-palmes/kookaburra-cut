import { useEffect, useState } from "react";
import { PROJECT_TEMPLATES, slugifyName } from "../engine/workspace";
import { listThemeChoices, type ThemeChoice, ThemeGrid } from "./ThemePicker";
import { useEscapeClose } from "./useEscapeClose";

/** First-run workspace chooser: Continue picks ~/Kookaburra Cut, or a custom parent via the native folder picker. Blocks the editor until a workspace exists, since everything project-shaped depends on it. (Default moved out of ~/Documents 2026-07-05: macOS TCC guards Documents and kept breaking headless gates and terminal-driven workflows.) */
export function FirstRunDialog({
  onContinue,
  onChoose,
}: {
  onContinue: () => Promise<void>;
  onChoose: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(String(e));
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
        <h2>Where should Kookaburra Cut keep your projects?</h2>
        <p className="muted">
          Kookaburra Cut creates a <code>Kookaburra Cut</code> folder for your video projects. The
          default is your home folder — you can pick somewhere else.
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={run(onChoose)} disabled={busy}>
            Choose folder…
          </button>
          <button type="button" className="btn primary" onClick={run(onContinue)} disabled={busy}>
            Continue
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

/** Create-project dialog: name + template, then the theme grid with hover-cycled previews. The theme applies to the new project's `project.json` after the template copy (`set_project_theme`). */
export function NewProjectDialog({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, templateId: string, themeId: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"details" | "theme">("details");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>(PROJECT_TEMPLATES[0].id);
  const [themeId, setThemeId] = useState("kookaburra-studio-white");
  const [themes, setThemes] = useState<ThemeChoice[]>([]);
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
      await onCreate(name, templateId, themeId);
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
