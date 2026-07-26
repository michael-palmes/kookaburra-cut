import { useEffect, useState } from "react";
import { readPackSceneSource } from "../../engine/packs";
import type { PackManifest } from "../types";

/** Read-only source disclosure. No syntax highlighting library, no execution, no dangerouslySetInnerHTML. */
export function CodeView({
  path,
  manifest,
  onBack,
}: {
  path: string;
  manifest: PackManifest;
  onBack: () => void;
}) {
  const files = manifest.contents.projects.flatMap((p) =>
    p.sceneFiles.map((file) => ({ project: p.slug, projectName: p.name, file })),
  );
  const [selected, setSelected] = useState(files[0] ?? null);
  const [source, setSource] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    setSource("");
    setError(null);
    readPackSceneSource(path, selected.project, selected.file)
      .then(setSource)
      .catch((e) => setError(String(e)));
  }, [path, selected]);

  return (
    <div className="packs-body">
      <div className="packs-rail" role="tablist" aria-label="Scene files">
        {files.map((f) => (
          <button
            key={`${f.project}/${f.file}`}
            type="button"
            className="packs-rail-item"
            role="tab"
            aria-selected={selected?.project === f.project && selected?.file === f.file}
            onClick={() => setSelected(f)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {f.projectName}/{f.file}
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
