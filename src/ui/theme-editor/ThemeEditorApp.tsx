import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { revealApp } from "../../engine/reveal";
import { defaultTheme } from "../../theme/registry";
import type { Theme } from "../../theme/tokens";
import { useNativeTextUndo } from "../useNativeTextUndo";
import { ColoursSection } from "./ColoursSection";
import { GradientsSection } from "./GradientsSection";
import { IdentitySection } from "./IdentitySection";
import { ThemeEditorIcon, type ThemeEditorIconName } from "./icons";
import { MotionSection } from "./MotionSection";
import { PlaceholderSection } from "./PlaceholderSection";
import { SpecimenPanel } from "./SpecimenPanel";
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

/** The theme editor window shell: section nav on the left, the active form in the centre, the specimen on the right. It edits ONE raw theme document at a time, held as a JSON draft, so the catalogue block and any block without a form yet survive every save. */

type SectionId =
  | "identity"
  | "colours"
  | "gradients"
  | "typography"
  | "motion"
  | "stage"
  | "lighting"
  | "effects";

const SECTIONS: readonly { id: SectionId; label: string; icon: ThemeEditorIconName }[] = [
  { id: "identity", label: "Identity", icon: "identity" },
  { id: "colours", label: "Colours", icon: "colours" },
  { id: "gradients", label: "Gradients", icon: "gradients" },
  { id: "typography", label: "Typography", icon: "typography" },
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

  const dirty = doc !== null && draftIsDirty(doc, savedText);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(async (id: string) => {
    const text = await readThemeDocText(id);
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
      load(id)
        .catch((e) => {
          setDoc(null);
          setThemeId(id);
          setError(String(e));
        })
        .finally(() => setBusy(false));
    },
    [load],
  );

  useEffect(() => {
    revealApp();
    invoke<ThemeEditorTarget | null>("get_theme_editor_target")
      .then((target) => {
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
      if (dirtyRef.current) {
        const discard = await ask(
          "This theme has unsaved changes. Open the other theme and discard them?",
          { title: "Unsaved changes", kind: "warning" },
        );
        if (!discard) return;
      }
      openTarget(next);
    });
    return () => {
      void pending.then((un) => un());
    };
  }, [openTarget]);

  // Unsaved-changes guard on close, the video editor's pattern.
  useEffect(() => {
    const pending = getCurrentWindow().onCloseRequested(async (event) => {
      if (!dirtyRef.current) return;
      const close = await ask("This theme has unsaved changes. Close anyway?", {
        title: "Unsaved changes",
        kind: "warning",
      });
      if (!close) event.preventDefault();
    });
    return () => {
      void pending.then((un) => un());
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
    writeThemeDocText(themeId, text)
      .then(async () => {
        setSavedText(text);
        await emitThemeSaved({ themeId, json: text });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [doc, themeId]);

  const revert = useCallback(() => {
    if (!themeId) return;
    setBusy(true);
    load(themeId)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [themeId, load]);

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
              disabled={busy || !dirty}
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

          <main className="theme-editor-form">
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
            {section === "motion" && (
              <MotionSection key={themeId ?? ""} doc={doc} onPatch={setDoc} theme={theme} />
            )}
            {section === "stage" && (
              <PlaceholderSection
                title="Stage"
                icon="stage"
                hint="The theme's default backdrop and camera-locked background."
                doc={doc}
                blocks={[
                  { key: "backdrop", label: "Backdrop" },
                  { key: "background", label: "Background" },
                ]}
              />
            )}
            {section === "lighting" && (
              <PlaceholderSection
                title="Lighting"
                icon="lighting"
                hint="The theme layer of the three-layer lighting stack, plus the HDRI environment."
                doc={doc}
                blocks={[
                  { key: "lighting", label: "Lighting" },
                  { key: "environment", label: "Environment" },
                ]}
              />
            )}
            {section === "effects" && (
              <PlaceholderSection
                title="Effects"
                icon="effects"
                hint="Bloom, vignette, colour grade and grain."
                doc={doc}
                blocks={[{ key: "effects", label: "Effects" }]}
              />
            )}
          </main>

          <SpecimenPanel theme={theme} />
        </div>
      )}
    </div>
  );
}
