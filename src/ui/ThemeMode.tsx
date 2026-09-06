import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { nameCollision, nameCollisionWarning } from "../engine/nameCollision";
import { WORKSPACE_THEME_PREFIX } from "../theme/registry";
import type { FontRef } from "../theme/tokens";
import { FontPicker } from "./FontPicker";
import { LibraryModalHeader } from "./LibraryModalHeader";
import { NamePromptModal } from "./NamePromptModal";
import { SceneMenuIcon } from "./sceneMenu";
import {
  builtinThemeChoices,
  listThemeChoices,
  recordSuccessfulThemeUse,
  ThemeBrowser,
  type ThemeChoice,
} from "./ThemePicker";
import { ThemeEditorIcon } from "./theme-editor/icons";
import { canEditTheme, onThemeSaved, openThemeEditor } from "./theme-editor/themeEditorIo";
import { useThemeCardMenu } from "./themeCardMenu";
import { useEscapeClose } from "./useEscapeClose";

/** Main-window theme mode: browse the theme library, apply one to the project, start a new theme, or duplicate any theme into a workspace theme (the starting point for user themes, locked decision 11); modal shell per the MediaLibrary pattern. */

/** What "New theme" copies: the neutral light starter, so a fresh theme opens on something legible rather than on the default's staging. */
const NEW_THEME_BASE_ID = "kookaburra-studio-white";
export function ThemeMode({
  currentThemeId,
  initialView,
  initialThemeId,
  onApply,
  onDuplicate,
  onThemeEdited,
  onEditInClaude,
  onClose,
}: {
  currentThemeId?: string;
  /** Land on a specific pane at open (the theme context menu). */
  initialView?: "fonts" | "duplicate";
  /** Pre-select a theme at open (rides with initialView). */
  initialThemeId?: string;
  /** Write the pick to project.json and reload the project. */
  onApply?: (themeId: string) => Promise<void>;
  /** Create `~/Kookaburra Cut/themes/<slug>` from a base theme; returns the new ws id. */
  onDuplicate: (name: string, baseThemeId: string, replace?: boolean) => Promise<string>;
  /** A ws theme's JSON changed; regenerate previews and reload if the project uses it. */
  onThemeEdited: (wsId: string, json: string) => Promise<void>;
  onEditInClaude?: (choice: ThemeChoice) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [choices, setChoices] = useState<ThemeChoice[]>(builtinThemeChoices);
  const [selected, setSelected] = useState(initialThemeId ?? currentThemeId ?? NEW_THEME_BASE_ID);
  const [view, setView] = useState<"browse" | "duplicate" | "fonts">(
    initialView === "duplicate" ? "duplicate" : "browse",
  );
  const [dupName, setDupName] = useState("");
  const [fontSlot, setFontSlot] = useState<"headline" | "body">("headline");
  const [fontDraft, setFontDraft] = useState<{ headline: FontRef; body: FontRef } | null>(null);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  useEscapeClose(onClose, !busy && !naming);
  const [error, setError] = useState<string | null>(null);
  // Two-step workspace-theme delete, parity with export presets.
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate disarm on selection change
  useEffect(() => setConfirmDelete(false), [selected]);
  // Same two-step for a duplicate that would overwrite a workspace theme.
  const [confirmReplace, setConfirmReplace] = useState(false);
  useEffect(() => {
    if (!confirmReplace) return;
    const timer = window.setTimeout(() => setConfirmReplace(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmReplace]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate disarm as the name is retyped
  useEffect(() => setConfirmReplace(false), [dupName]);

  const selectedIsWs = selected.startsWith(WORKSPACE_THEME_PREFIX);
  const dup = nameCollision(
    dupName,
    choices
      .filter((c) => c.source === "workspace")
      .map((c) => c.id.slice(WORKSPACE_THEME_PREFIX.length)),
  );
  let duplicateLabel = "Create theme";
  if (busy) duplicateLabel = "Creating…";
  else if (dup.collides) duplicateLabel = confirmReplace ? "Really replace?" : "Replace theme…";

  // Entering the fonts pane seeds the draft from the theme document on disk; body may be authored as a bare family string (schema v2 allows it), normalise to a FontRef.
  const openFonts = (themeId = selected) =>
    run(async () => {
      const slug = themeId.slice(WORKSPACE_THEME_PREFIX.length);
      const raw = JSON.parse(await invoke<string>("read_theme", { slug }));
      const norm = (v: unknown, fallbackWeight: number): FontRef =>
        typeof v === "string"
          ? { family: v, weight: fallbackWeight }
          : {
              family: String((v as FontRef)?.family ?? "Inter"),
              weight: (v as FontRef)?.weight ?? fallbackWeight,
            };
      setFontDraft({
        headline: norm(raw?.typography?.headline, 600),
        body: norm(raw?.typography?.body, 400),
      });
      setFontSlot("headline");
      setView("fonts");
    });

  const saveFonts = () =>
    run(async () => {
      if (!fontDraft) return;
      const slug = selected.slice(WORKSPACE_THEME_PREFIX.length);
      const raw = JSON.parse(await invoke<string>("read_theme", { slug }));
      raw.typography = { ...raw.typography, headline: fontDraft.headline, body: fontDraft.body };
      const json = JSON.stringify(raw, null, 2);
      await invoke("write_theme", { slug, text: json });
      await onThemeEdited(selected, json);
      setView("browse");
      refresh();
    });

  const refresh = () => {
    void listThemeChoices().then(setChoices);
  };
  useEffect(refresh, []);

  // App owns preview regeneration and project refresh across every theme window.
  useEffect(() => {
    return onThemeSaved(() => {
      void listThemeChoices().then(setChoices);
    });
  }, []);

  // Land on the fonts pane when asked (the context menu's Edit fonts); its draft seeding is async, so it rides the same openFonts the button uses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    if (initialView === "fonts" && selected.startsWith(WORKSPACE_THEME_PREFIX)) openFonts();
  }, []);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    action()
      .then(() => setBusy(false))
      .catch((e) => {
        setError(String(e));
        setBusy(false);
      });
  };

  // New theme: a copy of the neutral starter straight into the workspace, then the editor opens on it.
  const createTheme = async (name: string) => {
    const id = await onDuplicate(name, NEW_THEME_BASE_ID);
    setSelected(id);
    setNaming(false);
    refresh();
    await openThemeEditor(id);
  };

  const themeMenu = useThemeCardMenu({
    onApply: onApply
      ? (id) => run(() => recordSuccessfulThemeUse(id, () => onApply(id)))
      : undefined,
    onManage: ({ view: nextView, themeId }) => {
      setSelected(themeId);
      if (nextView === "fonts") openFonts(themeId);
      else setView("duplicate");
    },
    onEditInClaude,
    onThemeEdited,
    onChanged: refresh,
    onError: setError,
  });

  useEffect(() => {
    if (view === "browse") searchRef.current?.focus();
  }, [view]);

  return (
    <div
      className={`modal-overlay${view === "browse" ? " add-scene-overlay" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={onApply ? "Project theme" : "Themes"}
    >
      {naming && (
        <NamePromptModal
          title="New theme"
          label="Theme name"
          initial=""
          submitLabel="Create and edit"
          hint="Starts from Studio White, saved into your workspace and opened in the theme editor."
          onCancel={() => setNaming(false)}
          onSubmit={createTheme}
        />
      )}
      <div
        className={
          view === "browse"
            ? "modal add-scene-modal theme-library-modal"
            : "modal wizard-wide wizard-theme-wide"
        }
      >
        {view === "browse" ? (
          <LibraryModalHeader
            title={onApply ? "Project theme" : "Themes"}
            query={query}
            onQueryChange={setQuery}
            searchRef={searchRef}
            searchLabel="Search themes"
            placeholder="Search themes…"
            busy={busy}
            onClose={onClose}
          />
        ) : (
          <div className="modal-header">
            <h2>{view === "duplicate" ? "Duplicate theme" : "Theme fonts"}</h2>
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              onClick={onClose}
              disabled={busy}
            />
          </div>
        )}
        {view === "browse" && (
          <>
            <p className="modal-hint theme-library-hint">
              {onApply
                ? "Hover a card to preview its four scenes. Applying re-themes every scene that doesn't set its own theme."
                : "Create and improve themes for your projects. Duplicate a built-in theme to make it your own."}
            </p>
            <ThemeBrowser
              choices={choices}
              value={selected}
              onChange={setSelected}
              onReordered={refresh}
              headerSearch={{ query, inputRef: searchRef }}
              onCardContextMenu={busy ? undefined : themeMenu.openMenu}
            />
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setNaming(true)}
                disabled={busy}
                title="Start a theme of your own from Studio White and open it in the editor"
              >
                <ThemeEditorIcon name="add" />
                New theme…
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setView("duplicate")}
                disabled={busy}
              >
                <SceneMenuIcon id="duplicate" />
                Duplicate…
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  run(async () => {
                    await openThemeEditor(selected);
                  })
                }
                disabled={busy || !canEditTheme(selected)}
                title={
                  canEditTheme(selected)
                    ? "Open this theme in the theme editor"
                    : "Built-in themes are read-only: duplicate first"
                }
              >
                <SceneMenuIcon id="rename" />
                Edit…
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => openFonts()}
                disabled={busy || !selectedIsWs}
                title={
                  selectedIsWs
                    ? "Change this theme's headline and body faces"
                    : "Built-in themes are read-only: duplicate first"
                }
              >
                <ThemeEditorIcon name="typography" />
                Edit fonts…
              </button>
              <button
                type="button"
                className={`btn${confirmDelete ? " danger" : ""}`}
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  setConfirmDelete(false);
                  run(async () => {
                    const slug = selected.slice(WORKSPACE_THEME_PREFIX.length);
                    await invoke("delete_theme", { slug });
                    setSelected(currentThemeId ?? NEW_THEME_BASE_ID);
                    refresh();
                  });
                }}
                disabled={busy || !selectedIsWs}
                title={
                  selectedIsWs
                    ? "Delete this workspace theme (projects using it fall back to the default)"
                    : "Built-in themes can't be deleted"
                }
              >
                <SceneMenuIcon id="delete" />
                {confirmDelete ? "Really delete?" : "Delete…"}
              </button>
              {onApply && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() =>
                    run(async () => {
                      await recordSuccessfulThemeUse(selected, () => onApply(selected));
                    })
                  }
                  disabled={busy || selected === currentThemeId}
                >
                  <ThemeEditorIcon name="save" />
                  {busy ? "Applying…" : "Apply theme"}
                </button>
              )}
            </div>
          </>
        )}
        {view === "fonts" && fontDraft && (
          <>
            <div className="font-slot-row">
              {(["headline", "body"] as const).map((slot) => (
                <button
                  type="button"
                  key={slot}
                  className={`chip${fontSlot === slot ? " selected" : ""}`}
                  onClick={() => setFontSlot(slot)}
                >
                  <ThemeEditorIcon name={slot} />
                  {slot === "headline" ? "Headline" : "Body"}: {fontDraft[slot].family} ·{" "}
                  {fontDraft[slot].weight}
                </button>
              ))}
            </div>
            <FontPicker
              value={fontDraft[fontSlot]}
              onPick={(ref) => setFontDraft({ ...fontDraft, [fontSlot]: ref })}
            />
            <p className="modal-hint">
              System fonts are pinned into your workspace on first use, so exports never drift with
              macOS updates.
            </p>
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setView("browse")}
                disabled={busy}
              >
                <ThemeEditorIcon name="revert" />
                Back
              </button>
              <button type="button" className="btn primary" onClick={saveFonts} disabled={busy}>
                <ThemeEditorIcon name="save" />
                {busy ? "Saving…" : "Save fonts"}
              </button>
            </div>
          </>
        )}
        {view === "duplicate" && (
          <>
            <p className="modal-hint">
              Copies “{choices.find((c) => c.id === selected)?.name ?? selected}” into your
              workspace, ready to edit and use in any project.
            </p>
            <input
              className="modal-input"
              type="text"
              placeholder="Theme name"
              value={dupName}
              // biome-ignore lint/a11y/noAutofocus: the pane exists solely to type a name
              autoFocus
              onChange={(e) => setDupName(e.target.value)}
            />
            <p className="modal-hint">
              {dup.slug ? `Saved as themes/${dup.slug}` : "Name the new theme."}
            </p>
            {dup.collides && (
              <p className="modal-warn">
                {nameCollisionWarning("theme", dup.slug)} Saving replaces it.
              </p>
            )}
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setView("browse")}
                disabled={busy}
              >
                <ThemeEditorIcon name="revert" />
                Back
              </button>
              <button
                type="button"
                className={`btn ${dup.collides && confirmReplace ? "danger" : "primary"}`}
                disabled={busy || !dup.slug}
                onClick={() => {
                  if (dup.collides && !confirmReplace) {
                    setConfirmReplace(true);
                    return;
                  }
                  setConfirmReplace(false);
                  run(async () => {
                    const id = await onDuplicate(dupName, selected, dup.collides);
                    setSelected(id);
                    setView("browse");
                    setDupName("");
                    refresh();
                  });
                }}
              >
                <SceneMenuIcon id="duplicate" />
                {duplicateLabel}
              </button>
            </div>
          </>
        )}
        {themeMenu.menuElement}
      </div>
    </div>
  );
}
