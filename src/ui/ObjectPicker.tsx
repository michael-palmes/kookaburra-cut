import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { importObject, listObjects, type ResolvedObjectAsset } from "../toolkit/objects/registry";
import { useEscapeClose } from "./useEscapeClose";

/** The object library picker: bundled + workspace objects as thumbnail cards (a missing thumbnail degrades to a name card), plus the Import GLB flow (native-side copy into ~/Kookaburra Cut/objects). Picking hands the manifest id to the host, which writes the sidecar entry. */
export function ObjectPicker({
  onPick,
  onCancel,
}: {
  onPick: (objectId: string) => void;
  onCancel: () => void;
}) {
  const [objects, setObjects] = useState<ResolvedObjectAsset[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(onCancel, !busy);

  useEffect(() => {
    let cancelled = false;
    listObjects()
      .then((list) => {
        if (!cancelled) setObjects(list);
      })
      .catch((e) => {
        if (!cancelled) {
          setObjects([]);
          setError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleImport = async () => {
    const picked = await openFilePicker({
      multiple: false,
      title: "Import a 3D object",
      filters: [{ name: "glTF Binary", extensions: ["glb"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    setBusy(true);
    setError(null);
    try {
      const stem =
        picked
          .split("/")
          .pop()
          ?.replace(/\.glb$/i, "") ?? "object";
      const id = await importObject(stem.replace(/[-_]+/g, " "), picked);
      onPick(id);
    } catch (e) {
      console.warn("[objects] import failed:", e);
      setError(`Import failed: ${String(e)}`);
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add an object">
      <div className="modal wizard-wide">
        <h2>Add an object</h2>
        {objects === null ? (
          <p className="muted">Reading your object library…</p>
        ) : (
          <div className="object-picker-grid">
            {objects.map((o) => (
              <button
                key={o.manifest.id}
                type="button"
                className="object-card"
                disabled={busy}
                onClick={() => onPick(o.manifest.id)}
              >
                <span className="object-card-thumb">
                  {o.thumbnailUrl ? <img src={o.thumbnailUrl} alt="" /> : <ObjectGlyph />}
                </span>
                <span className="object-card-name">{o.manifest.name}</span>
              </button>
            ))}
          </div>
        )}
        <p className="modal-hint">
          Imported .glb files land in your workspace's objects library and travel in packs.
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-left"
            onClick={() => void handleImport()}
            disabled={busy}
          >
            {busy ? "Importing…" : "Import GLB…"}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ObjectGlyph() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
    >
      <path d="M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5L10 2.5z" />
      <path d="M10 2.5v7.5m0 0l6.5-3.75M10 10l-6.5-3.75" />
    </svg>
  );
}
