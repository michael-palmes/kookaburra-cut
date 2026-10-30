import { useEffect, useState } from "react";
import { readPackSceneSource } from "../../engine/packs";
import { KIND_LABELS, type SceneSource } from "../types";

/** Read-only source disclosure over the scene code the reader found in the signed file list, never the manifest's own description of itself. No syntax highlighting library, no execution, no dangerouslySetInnerHTML. */
export function CodeView({
  path,
  sources,
  onBack,
}: {
  path: string;
  sources: SceneSource[];
  onBack: () => void;
}) {
  const [selected, setSelected] = useState(sources[0] ?? null);
  const [source, setSource] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    setSource("");
    setError(null);
    readPackSceneSource(path, selected)
      .then(setSource)
      .catch((e) => setError(String(e)));
  }, [path, selected]);

  const isSelected = (s: SceneSource) =>
    selected?.kind === s.kind && selected.slug === s.slug && selected.file === s.file;

  return (
    <div className="packs-body">
      <div className="packs-rail" role="tablist" aria-label="Scene files">
        {sources.map((s) => (
          <button
            key={`${s.kind}:${s.slug}/${s.file}`}
            type="button"
            className="packs-rail-item"
            role="tab"
            aria-selected={isSelected(s)}
            onClick={() => setSelected(s)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {s.kind === "project" ? s.name : `${s.name} (${KIND_LABELS[s.kind].one})`}/{s.file}
            </span>
          </button>
        ))}
      </div>
      <div className="packs-main">
        <div className="packs-scroll">
          {error ? (
            <div className="packs-drop-error">{error}</div>
          ) : (
            <pre className="packs-source">{source || "Loading…"}</pre>
          )}
        </div>
        <div className="packs-footer">
          <div className="packs-footer-summary">
            This is the code that would run when you open the project. Nothing runs while you read
            it.
          </div>
          <div className="packs-actions">
            <button type="button" className="btn" onClick={onBack}>
              Back
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
