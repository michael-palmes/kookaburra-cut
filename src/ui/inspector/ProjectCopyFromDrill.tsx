import { useEffect, useState } from "react";
import { copySceneToProject, listProjectScenes } from "../../engine/projectEdit";
import type { WorkspaceProjectInfo } from "../../engine/workspace";
import { formatSceneLengthMs } from "../durationText";
import { SceneMenuIcon, sceneSelectionLabel } from "../sceneMenu";
import { ProjectPickerBody, useOtherProjects } from "./ProjectCopyDrill";
import { DrillBack } from "./rows";

interface SceneRow {
  index: number;
  name: string;
  durationMs: number;
}

/** Source picker for "Copy from project…": choose another workspace project, then tick the scenes to copy into this one. Copies land at the end, sequentially, the copy-to ordering rule. */
export function ProjectCopyFromDrill({
  slug,
  onBack,
  onDone,
}: {
  /** The CURRENT project (the copy destination). */
  slug: string;
  onBack: () => void;
  /** All copies landed; the host closes the drill, reloads the project and toasts. */
  onDone: (sourceName: string, count: number) => void;
}) {
  const { projects, loadError } = useOtherProjects(slug);
  const [source, setSource] = useState<WorkspaceProjectInfo | null>(null);
  const [scenes, setScenes] = useState<SceneRow[] | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setScenes(null);
    setSceneError(null);
    setSelected(new Set());
    setQuery("");
    listProjectScenes(source.slug)
      .then((rows) => {
        if (!cancelled) setScenes(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          setScenes([]);
          setSceneError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const selection = [...selected].sort((a, b) => a - b);

  const copySelected = async () => {
    if (!source || busy || selection.length === 0) return;
    setBusy(true);
    setSceneError(null);
    try {
      for (const index of selection) {
        await copySceneToProject(source.slug, index, slug);
      }
      onDone(source.name, selection.length);
    } catch (e) {
      setSceneError(String(e));
      setBusy(false);
    }
  };

  if (!source) {
    return (
      <div className="inspector-drill">
        <DrillBack label="Scenes" title="Copy from project" onClick={onBack} />
        <div className="inspector-drill-body">
          <p className="modal-hint">Pick the project to copy scenes from.</p>
          {loadError && <p className="modal-error">{loadError}</p>}
          <ProjectPickerBody projects={projects} onPick={setSource} />
        </div>
      </div>
    );
  }

  const trimmedQuery = query.trim().toLocaleLowerCase();
  const visible = (scenes ?? []).filter(
    (scene) => !trimmedQuery || scene.name.toLocaleLowerCase().includes(trimmedQuery),
  );

  return (
    <div className="inspector-drill">
      <DrillBack label="Copy from" title={source.name} onClick={() => setSource(null)} />
      <div className="inspector-drill-body">
        <p className="modal-hint">
          Ticked scenes copy to the end of this project, with their documents and any media they
          use. “{source.name}” keeps its own.
        </p>
        {sceneError && <p className="modal-error">{sceneError}</p>}
        {scenes === null ? (
          <p className="muted">Reading scenes…</p>
        ) : scenes.length === 0 ? (
          <p className="muted">No scenes in this project.</p>
        ) : (
          <>
            <input
              className="modal-input"
              type="search"
              placeholder="Search scenes…"
              aria-label="Search scenes"
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
              <p className="muted">No scenes match.</p>
            ) : (
              <div className="scene-pick-list" role="listbox" aria-label="Scenes to copy">
                {visible.map((scene) => {
                  const ticked = selected.has(scene.index);
                  return (
                    <div
                      key={scene.index}
                      role="option"
                      tabIndex={0}
                      aria-selected={ticked}
                      className={`scene-manager-row scene-pick-row${ticked ? " selected" : ""}`}
                      onClick={() => {
                        if (busy) return;
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(scene.index)) next.delete(scene.index);
                          else next.add(scene.index);
                          return next;
                        });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.currentTarget.click();
                        }
                      }}
                    >
                      <span className="scene-pick-check" aria-hidden>
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          {ticked ? <path d="M3.5 8.5 6.5 11.5 12.5 4.5" /> : null}
                        </svg>
                      </span>
                      <span className="scene-manager-name">{scene.name}</span>
                      <span className="scene-manager-duration">
                        {formatSceneLengthMs(scene.durationMs)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      <div className="inspector-drill-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || selection.length === 0}
          onClick={() => void copySelected()}
        >
          <SceneMenuIcon id="copy-from-project" />
          {busy ? "Copying…" : sceneSelectionLabel("Copy", selection.length)}
        </button>
      </div>
    </div>
  );
}
