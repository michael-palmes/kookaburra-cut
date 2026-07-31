import { useEffect, useState } from "react";
import { copySceneToProject } from "../engine/projectEdit";
import { listProjects, type WorkspaceProjectInfo } from "../engine/workspace";
import { useEscapeClose } from "./useEscapeClose";

/** Destination picker for "Copy to project…": every workspace project except the current one; copying runs sequentially so multi-select stems never race the destination's numbering. */
export function CopySceneModal({
  slug,
  indices,
  sceneLabel,
  onDone,
  onCancel,
}: {
  slug: string;
  /** Manifest indices to copy, in order. */
  indices: number[];
  /** Menu-facing description, e.g. a scene name or "3 scenes". */
  sceneLabel: string;
  /** All copies landed; the host toasts and closes. */
  onDone: (destName: string) => void;
  onCancel: () => void;
}) {
  const [projects, setProjects] = useState<WorkspaceProjectInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(onCancel, busy === null);
  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (!cancelled) setProjects(list.filter((p) => p.slug !== slug));
      })
      .catch((e) => {
        if (!cancelled) {
          setProjects([]);
          setError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const copyInto = async (dest: WorkspaceProjectInfo) => {
    if (busy) return;
    setBusy(dest.slug);
    setError(null);
    try {
      for (const index of indices) {
        await copySceneToProject(slug, index, dest.slug);
      }
      onDone(dest.name);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Copy ${sceneLabel} to a project`}
    >
      <div className="modal">
        <h2>Copy {sceneLabel} to…</h2>
        {projects === null ? (
          <p className="muted">Reading your workspace…</p>
        ) : projects.length === 0 ? (
          <p className="muted">No other projects in your workspace yet.</p>
        ) : (
          <div className="copy-scene-projects">
            {projects.map((p) => (
              <button
                key={p.slug}
                type="button"
                className="rail-menu-item copy-scene-project"
                disabled={busy !== null}
                onClick={() => void copyInto(p)}
              >
                {busy === p.slug ? `Copying into ${p.name}…` : p.name}
              </button>
            ))}
          </div>
        )}
        <p className="modal-hint">
          The scene, its document and any media it uses copy across; this project keeps its own.
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
