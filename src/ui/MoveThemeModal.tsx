import { useEffect, useState } from "react";
import { slugifyName } from "../engine/workspace";
import { BUILTIN_THEME_CATALOGUE, THEME_CATEGORIES } from "../theme/catalogue";
import { THEME_CATEGORY_ICONS } from "./libraryIcons";
import type { ThemeChoice } from "./ThemePicker";
import { ThemeEditorIcon } from "./theme-editor/icons";
import { readThemeSourceDoc } from "./theme-editor/themeEditorIo";
import { moveTheme, type ThemeMoveResult } from "./theme-editor/themeMove";
import { useEscapeClose } from "./useEscapeClose";

export function MoveThemeModal({
  choice,
  onMoved,
  onCancel,
}: {
  choice: ThemeChoice;
  onMoved: (result: ThemeMoveResult) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(choice.name);
  const [category, setCategory] = useState(choice.category ?? "essentials");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = slugifyName(name);
  const collision = BUILTIN_THEME_CATALOGUE.some((entry) => entry.id === id);
  useEscapeClose(() => {
    if (!busy) onCancel();
  });
  useEffect(() => {
    let cancelled = false;
    void readThemeSourceDoc(choice.id)
      .then((doc) => {
        const metadata = doc.catalogue as { category?: typeof category } | undefined;
        if (!cancelled && THEME_CATEGORIES.some((entry) => entry.id === metadata?.category))
          setCategory(metadata?.category ?? "essentials");
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [choice.id]);
  const submit = async () => {
    if (busy || !id || collision) return;
    setBusy(true);
    setError(null);
    try {
      onMoved(await moveTheme(choice.id.slice(3), id, name.trim(), category));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Move to app themes">
      <div className="modal">
        <h2>Move to app themes</h2>
        <label className="wizard-field">
          <span className="wizard-label">Theme name</span>
          <input
            className="modal-input"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="modal-hint">App identity: {id || "Enter a name"}</p>
        <div className="wizard-field">
          <span className="wizard-label">Category</span>
          <fieldset className="chip-row" aria-label="Theme category">
            {THEME_CATEGORIES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`btn btn-small chip-with-icon${category === entry.id ? " active" : ""}`}
                aria-pressed={category === entry.id}
                disabled={busy}
                onClick={() => setCategory(entry.id)}
              >
                {THEME_CATEGORY_ICONS[entry.id]}
                {entry.label}
              </button>
            ))}
          </fieldset>
        </div>
        <p className="modal-hint">
          Saves pending edits, moves this theme into the checkout and updates matching references in
          this workspace and checkout. Recovery copies are retained. Other app installations need a
          build containing the new app theme.
        </p>
        {collision && (
          <p className="modal-warn">
            An app theme already uses this identity. Choose another name.
          </p>
        )}
        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn chip-with-icon" disabled={busy} onClick={onCancel}>
            <ThemeEditorIcon name="revert" />
            Cancel
          </button>
          <button
            type="button"
            className="btn primary chip-with-icon"
            disabled={busy || !id || collision}
            onClick={() => void submit()}
          >
            <ThemeEditorIcon name="save" />
            {busy ? "Moving…" : "Move to app themes"}
          </button>
        </div>
      </div>
    </div>
  );
}
