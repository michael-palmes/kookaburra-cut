import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { renderObjectThumbnail } from "../engine/objectThumbnail";
import { optionPreviewStill } from "../engine/optionPreviews";
import {
  importObject,
  listObjects,
  type ResolvedObjectAsset,
  writeObjectThumbnail,
} from "../toolkit/objects/registry";
import { useEscapeClose } from "./useEscapeClose";

export function objectPickerFocusTarget(
  objects: readonly ResolvedObjectAsset[] | null,
  error: string | null,
): "object" | "import" | null {
  if (error) return "import";
  if (objects === null) return null;
  return objects.length > 0 ? "object" : "import";
}

/** The object library picker: bundled + workspace objects as thumbnail cards (a missing thumbnail degrades to a name card), plus the Import GLB flow (native-side copy into ~/Kookaburra Cut/objects). Picking hands the manifest id to the host, which writes the sidecar entry. */
export function ObjectPicker({
  onPick,
  onCancel,
  embedded = false,
}: {
  onPick: (objectId: string) => void | Promise<void>;
  onCancel: () => void;
  embedded?: boolean;
}) {
  const [objects, setObjects] = useState<ResolvedObjectAsset[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstObjectRef = useRef<HTMLButtonElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  useEscapeClose(onCancel, !busy && !embedded);

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

  useEffect(() => {
    if (busy || embedded) return;
    const target = objectPickerFocusTarget(objects, error);
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const element = target === "object" ? firstObjectRef.current : importButtonRef.current;
      element?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [objects, error, busy, embedded]);

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
      // Best effort: a failed render just leaves the glyph card.
      const asset = (await listObjects()).find((o) => o.manifest.id === id);
      if (asset) {
        const png = await renderObjectThumbnail(asset.glbUrl);
        if (png) await writeObjectThumbnail(id, png);
      }
      await onPick(id);
      setBusy(false);
    } catch (e) {
      console.warn("[objects] import failed:", e);
      setError(`Import failed: ${String(e)}`);
      setBusy(false);
    }
  };

  const handlePick = async (objectId: string) => {
    setBusy(true);
    setError(null);
    try {
      await onPick(objectId);
    } catch (e) {
      console.warn("[objects] add failed:", e);
      setError(`Add failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      {objects === null ? (
        <p className="muted">Reading your object library…</p>
      ) : (
        <div className="object-picker-grid">
          {objects.map((o, index) => (
            <button
              key={o.manifest.id}
              ref={index === 0 ? firstObjectRef : undefined}
              type="button"
              className="object-card"
              disabled={busy}
              onClick={() => void handlePick(o.manifest.id)}
            >
              <span className="object-card-thumb">
                {(() => {
                  const still =
                    o.thumbnailUrl ?? optionPreviewStill(`object-${o.manifest.id}`) ?? undefined;
                  return still ? <img src={still} alt="" /> : <ObjectGlyph />;
                })()}
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
    </>
  );
  const actions = (
    <>
      <button
        ref={importButtonRef}
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
    </>
  );

  if (embedded) {
    return (
      <>
        <div className="inspector-drill-body inspector-object-picker-body">{body}</div>
        <div className="inspector-drill-actions">{actions}</div>
      </>
    );
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add an object">
      <div className="modal wizard-wide">
        <h2>Add an object</h2>
        {body}
        <div className="modal-actions">{actions}</div>
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
