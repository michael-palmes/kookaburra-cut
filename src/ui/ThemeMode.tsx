import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { slugifyName } from "../engine/workspace";
import { WORKSPACE_THEME_PREFIX } from "../theme/registry";
import type { FontRef } from "../theme/tokens";
import { FontPicker } from "./FontPicker";
import { listThemeChoices, type ThemeChoice, ThemeGrid } from "./ThemePicker";
import { useEscapeClose } from "./useEscapeClose";

/** Main-window theme mode: browse the theme library, apply one to the project, or duplicate any theme into a workspace theme (the starting point for user themes, locked decision 11: token-level tweaks duplicate the theme, deep edits go through Claude on the JSON); modal shell per the MediaLibrary pattern. */
export function ThemeMode({
  currentThemeId,
  initialView,
  initialThemeId,
  onApply,
  onDuplicate,
  onThemeEdited,
  onClose,
}: {
  currentThemeId: string;
  /** Land on a specific pane at open (the theme context menu). */
  initialView?: "fonts" | "duplicate";
  /** Pre-select a theme at open (rides with initialView). */
  initialThemeId?: string;
  /** Write the pick to project.json and reload the project. */
  onApply: (themeId: string) => Promise<void>;
  /** Create `~/Kookaburra Cut/themes/<slug>` from a base theme; returns the new ws id. */
  onDuplicate: (name: string, baseThemeId: string) => Promise<string>;
  /** A ws theme's JSON changed; regenerate previews and reload if the project uses it. */
  onThemeEdited: (wsId: string, json: string) => Promise<void>;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<ThemeChoice[]>([]);
  const [selected, setSelected] = useState(initialThemeId ?? currentThemeId);
  const [view, setView] = useState<"browse" | "duplicate" | "fonts">(
    initialView === "duplicate" ? "duplicate" : "browse",
  );
  const [dupName, setDupName] = useState("");
  const [fontSlot, setFontSlot] = useState<"headline" | "body">("headline");
  const [fontDraft, setFontDraft] = useState<{ headline: FontRef; body: FontRef } | null>(null);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, !busy);
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

  const selectedIsWs = selected.startsWith(WORKSPACE_THEME_PREFIX);

  // Entering the fonts pane seeds the draft from the theme document on disk; body may be authored as a bare family string (schema v2 allows it), normalise to a FontRef.
  const openFonts = () =>
    run(async () => {
      const slug = selected.slice(WORKSPACE_THEME_PREFIX.length);
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

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Project theme">
      <div className="modal wizard-wide">
        <h2>
          {view === "browse" && "Project theme"}
          {view === "duplicate" && "Duplicate theme"}
          {view === "fonts" && "Theme fonts"}
        </h2>
        {view === "browse" && (
          <>
            <p className="modal-hint">
              Hover a card to preview its four scenes. Applying re-themes every scene that doesn't
              set its own theme.
            </p>
            <ThemeGrid choices={choices} value={selected} onChange={setSelected} />
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Close
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setView("duplicate")}
                disabled={busy}
              >
                Duplicate…
              </button>
              <button
                type="button"
                className="btn"
                onClick={openFonts}
                disabled={busy || !selectedIsWs}
                title={
                  selectedIsWs
                    ? "Change this theme's headline and body faces"
                    : "Built-in themes are read-only — duplicate first"
                }
              >
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
                    setSelected(currentThemeId);
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
                {confirmDelete ? "Really delete?" : "Delete…"}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => run(() => onApply(selected))}
                disabled={busy || selected === currentThemeId}
              >
                {busy ? "Applying…" : "Apply theme"}
              </button>
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
                  {slot === "headline" ? "Headline" : "Body"} — {fontDraft[slot].family} ·{" "}
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
                Back
              </button>
              <button type="button" className="btn primary" onClick={saveFonts} disabled={busy}>
                {busy ? "Saving…" : "Save fonts"}
              </button>
            </div>
          </>
        )}
        {view === "duplicate" && (
          <>
            <p className="modal-hint">
              Copies “{choices.find((c) => c.id === selected)?.name ?? selected}” into your
              workspace as an editable theme (previews render once it's saved).
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
              {slugifyName(dupName)
                ? `Saved as themes/${slugifyName(dupName)}`
                : "Name the new theme."}
            </p>
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setView("browse")}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !slugifyName(dupName)}
                onClick={() =>
                  run(async () => {
                    const id = await onDuplicate(dupName, selected);
                    setSelected(id);
                    setView("browse");
                    setDupName("");
                    refresh();
                  })
                }
              >
                {busy ? "Creating…" : "Create theme"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
