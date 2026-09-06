import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { revealApp } from "../../engine/reveal";
import { defaultTheme } from "../../theme/registry";
import type { Theme } from "../../theme/tokens";
import { useNativeTextUndo } from "../useNativeTextUndo";
import { ColoursSection } from "./ColoursSection";
import { EffectsSection } from "./EffectsSection";
import { GradientsSection } from "./GradientsSection";
import { IdentitySection } from "./IdentitySection";
import { ThemeEditorIcon, type ThemeEditorIconName } from "./icons";
import { LightingSection } from "./LightingSection";
import { MotionSection } from "./MotionSection";
import { SpecimenPanel } from "./SpecimenPanel";
import { StageSection } from "./StageSection";
import { TextLookSection } from "./TextLookSection";
import { TypographySection } from "./TypographySection";
import {
  isDirty as draftIsDirty,
  isRecord,
  parseThemeDraft,
  serialiseThemeDoc,
  type ThemeDoc,
  themeScope,
} from "./themeDraft";
import {
  canEditBundledThemes,
  emitThemeSaved,
  readThemeDocText,
  writeThemeDocText,
} from "./themeEditorIo";
import { createThemeWindowClose } from "./themeWindowClose";

/** The theme editor window shell: section nav on the left, the active form in the centre, the specimen on the right. It edits ONE raw theme document at a time, held as a JSON draft, so the catalogue block and any block without a form yet survive every save. */

type SectionId =
  | "identity"
  | "colours"
  | "gradients"
  | "typography"
  | "text-look"
  | "motion"
  | "stage"
  | "lighting"
  | "effects";

const SECTIONS: readonly { id: SectionId; label: string; icon: ThemeEditorIconName }[] = [
  { id: "identity", label: "Identity", icon: "identity" },
  { id: "colours", label: "Colours", icon: "colours" },
  { id: "gradients", label: "Gradients", icon: "gradients" },
  { id: "typography", label: "Typography", icon: "typography" },
  { id: "text-look", label: "Text style", icon: "headline" },
  { id: "motion", label: "Motion", icon: "motion" },
  { id: "stage", label: "Stage", icon: "stage" },
  { id: "lighting", label: "Lighting", icon: "lighting" },
  { id: "effects", label: "Effects", icon: "effects" },
];

interface ThemeEditorTarget {
  themeId: string;
}

export function ThemeEditorApp() {
  useNativeTextUndo();
  const [themeId, setThemeId] = useState<string | null>(null);
  const [doc, setDoc] = useState<ThemeDoc | null>(null);
  const [savedText, setSavedText] = useState("");
  const [section, setSection] = useState<SectionId>("identity");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadVersion = useRef(0);
  const targetVersion = useRef(0);
  const pendingSave = useRef<Promise<void> | null>(null);

  const dirty = doc !== null && draftIsDirty(doc, savedText);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(async (id: string) => {
    const version = ++loadVersion.current;
    const text = await readThemeDocText(id);
    if (version !== loadVersion.current) return;
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("that theme document isn't a JSON object");
    setThemeId(id);
    setDoc(parsed);
    setSavedText(text);
    setSection("identity");
    setError(null);
  }, []);

  const openTarget = useCallback(
    (id: string) => {
      setBusy(true);
      const loading = load(id);
      const version = loadVersion.current;
      loading
        .catch((e) => {
          if (version !== loadVersion.current) return;
          setDoc(null);
          setThemeId(id);
          setError(String(e));
        })
        .finally(() => {
          if (version === loadVersion.current) setBusy(false);
        });
    },
    [load],
  );

  useEffect(() => {
    revealApp();
    const version = targetVersion.current;
    invoke<ThemeEditorTarget | null>("get_theme_editor_target")
      .then((target) => {
        if (version !== targetVersion.current) return;
        if (target?.themeId) openTarget(target.themeId);
        else setError("No theme was requested. Open the editor from a theme card.");
      })
      .catch((e) => setError(String(e)));
  }, [openTarget]);

  // A second Edit… on another card retargets this window; unsaved work gets one chance to stay.
  useEffect(() => {
    const pending = listen<ThemeEditorTarget>("kookaburra://theme-editor-target", async (event) => {
      const next = event.payload.themeId;
      if (!next) return;
      const version = ++targetVersion.current;
      await pendingSave.current;
      if (version !== targetVersion.current) return;
      flushSync(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      if (dirtyRef.current) {
        const discard = await ask(
          "This theme has unsaved changes. Open the other theme and discard them?",
          { title: "Unsaved changes", kind: "warning" },
        );
        if (!discard || version !== targetVersion.current) return;
      }
      openTarget(next);
    });
    return () => {
      void pending.then((un) => un());
    };
  }, [openTarget]);

  useEffect(() => {
    const window = getCurrentWindow();
    const close = createThemeWindowClose({
      pendingSave: () => pendingSave.current,
      flushInput: () =>
        flushSync(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        }),
      isDirty: () => dirtyRef.current,
      confirmDiscard: () =>
        ask("This theme has unsaved changes. Close anyway?", {
          title: "Unsaved changes",
          kind: "warning",
        }),
      destroy: () => window.destroy(),
      onError: (e) => setError(`Couldn't close this theme: ${String(e)}`),
    });
    const pending = window.onCloseRequested(close.onClose);
    void pending.catch((e) => setError(`Couldn't register the close handler: ${String(e)}`));
    return () => {
      close.dispose();
      void pending.then((un) => un()).catch(() => {});
    };
  }, []);

  const parsed = useMemo(
    () => (doc ? parseThemeDraft(doc, themeId ?? "theme") : { theme: undefined, warnings: [] }),
    [doc, themeId],
  );

  // The last theme that parsed: an in-flight edit that breaks a required block must not blank the specimen.
  const lastGoodRef = useRef<Theme>(defaultTheme);
  if (parsed.theme) lastGoodRef.current = parsed.theme;
  const theme: Theme = parsed.theme ?? lastGoodRef.current;

  useEffect(() => {
    const name = theme.name || themeId;
    if (name) void getCurrentWindow().setTitle(`Kookaburra Cut — ${name}`);
  }, [theme.name, themeId]);

  const scope = themeId ? themeScope(themeId) : null;
  const canSave = scope !== null && (scope.kind === "workspace" || canEditBundledThemes);

  const save = useCallback(() => {
    if (!doc || !themeId) return;
    const text = serialiseThemeDoc(doc);
    setBusy(true);
    setError(null);
    const saving = writeThemeDocText(themeId, text)
      .then(async () => {
        flushSync(() => setSavedText(text));
        await emitThemeSaved({ themeId, json: text });
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        pendingSave.current = null;
        setBusy(false);
      });
    pendingSave.current = saving;
  }, [doc, themeId]);

  const revert = useCallback(() => {
    if (!themeId) return;
    openTarget(themeId);
  }, [themeId, openTarget]);

  return (
    <div className="theme-editor-window">
      <header className="theme-editor-titlebar" data-tauri-drag-region>
        {/* Only elements carrying the attribute start a window drag, so the whole title strip repeats it. */}
        <div className="theme-editor-title" data-tauri-drag-region>
          <ThemeEditorIcon name="colours" size={16} />
          <span data-tauri-drag-region>{theme.name || themeId || "Theme"}</span>
          {scope && (
            <span className="theme-editor-scope" data-tauri-drag-region>
              {scope.kind === "workspace" ? "Workspace theme" : "Built-in theme"}
            </span>
          )}
          {dirty && <span className="theme-editor-dot" title="Unsaved changes" />}
        </div>
        <div className="theme-editor-actions">
          <button
            type="button"
            className="btn btn-small chip-with-icon"
            onClick={revert}
            disabled={busy || !dirty}
          >
            <ThemeEditorIcon name="revert" size={14} />
            Revert
          </button>
          {canSave && (
            <button
              type="button"
              className="btn btn-small primary chip-with-icon"
              onClick={save}
              disabled={busy || !dirty || !parsed.theme}
            >
              <ThemeEditorIcon name="save" size={14} />
              {busy ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="theme-editor-error" role="alert">
          <ThemeEditorIcon name="warning" size={14} />
          {error}
        </p>
      )}

      {doc && (
        <div className="theme-editor-body">
          <nav className="theme-editor-nav" aria-label="Theme sections">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`theme-editor-nav-item${section === entry.id ? " active" : ""}`}
                aria-pressed={section === entry.id}
                onClick={() => setSection(entry.id)}
              >
                <ThemeEditorIcon name={entry.icon} size={16} />
                {entry.label}
              </button>
            ))}
            {!canSave && (
              <p className="theme-editor-nav-note">
                Built-in themes are read-only in a release build. Duplicate this theme to your
                library to edit it.
              </p>
            )}
          </nav>

          <main className="theme-editor-form" inert={busy}>
            {parsed.warnings.length > 0 && (
              <div className="theme-editor-warnings" role="status">
                <span>
                  <ThemeEditorIcon name="warning" size={14} />
                  {parsed.warnings.length === 1
                    ? "1 block will not load as written"
                    : `${parsed.warnings.length} blocks will not load as written`}
                </span>
                <ul>
                  {[...new Set(parsed.warnings)].map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            {section === "identity" && (
              <IdentitySection doc={doc} onPatch={setDoc} devTools={canEditBundledThemes} />
            )}
            {section === "colours" && <ColoursSection doc={doc} onPatch={setDoc} theme={theme} />}
            {section === "gradients" && (
              <GradientsSection doc={doc} onPatch={setDoc} theme={theme} />
            )}
            {section === "typography" && <TypographySection doc={doc} onPatch={setDoc} />}
            {section === "text-look" && (
              <TextLookSection key={themeId ?? ""} doc={doc} theme={theme} onPatch={setDoc} />
            )}
            {section === "motion" && (
              <MotionSection key={themeId ?? ""} doc={doc} onPatch={setDoc} theme={theme} />
            )}
            {section === "stage" && <StageSection doc={doc} onPatch={setDoc} theme={theme} />}
            {section === "lighting" && <LightingSection doc={doc} onPatch={setDoc} theme={theme} />}
            {section === "effects" && <EffectsSection doc={doc} onPatch={setDoc} />}
          </main>

          <SpecimenPanel theme={theme} />
        </div>
      )}
    </div>
  );
}
