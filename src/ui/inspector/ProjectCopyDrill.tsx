import { useEffect, useState } from "react";
import { copySceneToProject } from "../../engine/projectEdit";
import { listProjects, snapshotUrl, type WorkspaceProjectInfo } from "../../engine/workspace";
import { formatLastOpened, PlaceholderArt, sortProjectsByRecency } from "../projectLibrary";
import { DrillBack } from "./rows";

/** Destination picker for "Copy to project…": every workspace project except this one as a snapshot card, most recently opened first. Copying runs sequentially so a multi-scene selection never races the destination's numbering. */
export function ProjectCopyDrill({
  slug,
  indices,
  sceneLabel,
  onBack,
  onDone,
}: {
  slug: string;
  /** Manifest indices to copy, in order. */
  indices: number[];
  /** Menu-facing description, e.g. a scene name or "3 scenes". */
  sceneLabel: string;
  onBack: () => void;
  /** All copies landed; the host closes the drill and toasts. */
  onDone: (destName: string, count: number) => void;
}) {
  const [projects, setProjects] = useState<WorkspaceProjectInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (!cancelled) setProjects(sortProjectsByRecency(list.filter((p) => p.slug !== slug)));
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
    if (busy || indices.length === 0) return;
    setBusy(dest.slug);
    setError(null);
    try {
      for (const index of indices) {
        await copySceneToProject(slug, index, dest.slug);
      }
      onDone(dest.name, indices.length);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  };

  return (
    <div className="inspector-drill">
      <DrillBack label="Scenes" title="Copy to project" onClick={onBack} />
      <div className="inspector-drill-body">
        <p className="modal-hint">
          Copying {sceneLabel}. The scene, its document and any media it uses copy across; this
          project keeps its own.
        </p>
        {error && <p className="modal-error">{error}</p>}
        {projects === null ? (
          <p className="muted">Reading your workspace…</p>
        ) : projects.length === 0 ? (
          <p className="muted">No other projects in your workspace yet.</p>
        ) : (
          <div className="project-copy-grid">
            {projects.map((p) => {
              const url = snapshotUrl(p);
              return (
                <button
                  key={p.slug}
                  type="button"
                  className={`project-copy-card${busy === p.slug ? " busy" : ""}`}
                  disabled={busy !== null}
                  title={p.name}
                  onClick={() => void copyInto(p)}
                >
                  <span className="project-copy-thumb">
                    {url ? <img src={url} alt="" /> : <PlaceholderArt />}
                  </span>
                  <span className="project-copy-body">
                    <span className="project-copy-name">{p.name}</span>
                    <span className="project-copy-meta">
                      {busy === p.slug
                        ? "Copying…"
                        : (formatLastOpened(p.lastOpenedMs) ?? "Not opened yet")}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
