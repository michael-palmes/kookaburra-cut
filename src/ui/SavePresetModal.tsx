import { useState } from "react";
import { createPortal } from "react-dom";
import { type LibraryItemInfo, saveSceneAsPreset } from "../engine/library";
import { presetManifestSchema, refreshUserPresets } from "../engine/presets";
import { ItemDetailsModal } from "./ItemDetailsModal";
import type { ItemDetailsTarget } from "./libraryDetails";
import { modalHost } from "./modalHost";
import { useEscapeClose } from "./useEscapeClose";

/** Save-as-preset: says what travels, writes `~/Kookaburra Cut/presets/<slug>/` on the button (never on mount, which StrictMode would run twice), then hands the fresh copy to the details modal to be named and filed. */
export function SavePresetModal({
  projectSlug,
  sceneStem,
  sceneName,
  onClose,
}: {
  /** Source workspace project slug (no `ws:` prefix). */
  projectSlug: string;
  /** The scene's file stem (`03-stat-hero`), which the native side reads the TSX and sidecar from. */
  sceneStem: string;
  /** Display name for the copy, purely for the dialog's text. */
  sceneName: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<ItemDetailsTarget | null>(null);
  const [saved, setSaved] = useState<LibraryItemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(onClose, !busy && !details);

  const save = async () => {
    if (busy || details) return;
    setBusy(true);
    setError(null);
    try {
      const info = saved ?? (await saveSceneAsPreset(projectSlug, sceneStem));
      setSaved(info);
      const parsed = presetManifestSchema.safeParse(JSON.parse(info.manifestJson), info.slug);
      await refreshUserPresets();
      if (parsed.success) {
        setDetails({ kind: "preset", source: "user", slug: info.slug, manifest: parsed.data });
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  if (details) {
    return createPortal(
      <ItemDetailsModal
        target={details}
        title="File your new preset"
        hint="It is in your preset library. Reuse adopts the destination project's theme and styling while keeping scene overrides."
        submitLabel="Save details"
        onSaved={async () => {
          await refreshUserPresets();
          onClose();
        }}
        onCancel={onClose}
      />,
      modalHost(),
    );
  }

  return createPortal(
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Save as preset">
      <div className="modal">
        <h2>Save “{sceneName}” as a preset</h2>
        <p className="modal-hint">
          {saved
            ? `Saved as “${saved.slug}”. It is in your preset library.`
            : "The scene and its media copy into your preset library. Reuse adopts the destination project's theme and styling while keeping scene overrides."}
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          {saved ? (
            <>
              {error && (
                <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
                  {busy ? "Refreshing…" : "Retry library refresh"}
                </button>
              )}
              <button type="button" className="btn primary" onClick={onClose} disabled={busy}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save preset"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    modalHost(),
  );
}
