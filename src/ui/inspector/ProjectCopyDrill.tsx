import { useEffect, useState } from "react";
import { copySceneToProject } from "../../engine/projectEdit";
import { listProjects, snapshotUrl, type WorkspaceProjectInfo } from "../../engine/workspace";
import {
  ALL_PROJECTS,
  filterProjectLibrary,
  formatLastOpened,
  formatLastUpdated,
  PlaceholderArt,
  sortProjectsByUpdated,
} from "../projectLibrary";
import { DrillBack } from "./rows";

/** Every other workspace project, most recently updated first; projects is null while reading. */
export function useOtherProjects(slug: string): {
  projects: WorkspaceProjectInfo[] | null;
  loadError: string | null;
} {
  const [projects, setProjects] = useState<WorkspaceProjectInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (!cancelled) setProjects(sortProjectsByUpdated(list.filter((p) => p.slug !== slug)));
      })
      .catch((e) => {
        if (!cancelled) {
          setProjects([]);
          setLoadError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return { projects, loadError };
}

/** The searchable project card grid the copy-to and copy-from pickers share: snapshot cards, most recently updated first. */
export function ProjectPickerBody({
  projects,
  busySlug = null,
  busyLabel,
  disabled = false,
  onPick,
}: {
  projects: WorkspaceProjectInfo[] | null;
  /** The card an operation holds at full strength while the rest dim. */
  busySlug?: string | null;
  /** The busy card's meta line, e.g. "Copying…". */
  busyLabel?: string;
  disabled?: boolean;
  onPick: (project: WorkspaceProjectInfo) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = projects ? filterProjectLibrary(projects, ALL_PROJECTS, query) : [];

  if (projects === null) return <p className="muted">Reading your workspace…</p>;
  if (projects.length === 0) {
    return <p className="muted">No other projects in your workspace yet.</p>;
  }
  return (
    <>
      <input
        className="modal-input"
        type="search"
        placeholder="Search projects…"
        aria-label="Search projects"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            setQuery("");
            e.stopPropagation();
          }
        }}
      />
      {visible.length === 0 ? (
        <p className="muted">No projects match.</p>
      ) : (
        <div className="project-copy-grid">
          {visible.map((p) => {
            const url = snapshotUrl(p);
            return (
              <button
                key={p.slug}
                type="button"
                className={`project-copy-card${busySlug === p.slug ? " busy" : ""}`}
                disabled={disabled}
                title={p.name}
                onClick={() => onPick(p)}
              >
                <span className="project-copy-thumb">
                  {url ? <img src={url} alt="" /> : <PlaceholderArt />}
                </span>
                <span className="project-copy-body">
                  <span className="project-copy-name">{p.name}</span>
                  <span className="project-copy-meta">
                    {busySlug === p.slug && busyLabel
                      ? busyLabel
                      : (formatLastUpdated(p.contentMtimeMs) ??
                        formatLastOpened(p.lastOpenedMs) ??
                        "Not opened yet")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Destination picker for "Copy to project…": every workspace project except this one, searchable, most recently updated first. Copying runs sequentially so a multi-scene selection never races the destination's numbering. */
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
  const { projects, loadError } = useOtherProjects(slug);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        {(error ?? loadError) && <p className="modal-error">{error ?? loadError}</p>}
        <ProjectPickerBody
          projects={projects}
          busySlug={busy}
          busyLabel="Copying…"
          disabled={busy !== null}
          onPick={(p) => void copyInto(p)}
        />
      </div>
    </div>
  );
}
