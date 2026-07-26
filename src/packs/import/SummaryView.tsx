import { revealInFinder } from "../../engine/packs";
import { type ImportOutcome, type ItemOutcome, KIND_LABELS } from "../types";

const GROUPS: { outcome: ItemOutcome; label: string }[] = [
  { outcome: "added", label: "Added" },
  { outcome: "replaced", label: "Replaced" },
  { outcome: "keptBoth", label: "Kept both" },
  { outcome: "skipped", label: "Skipped" },
  { outcome: "failed", label: "Failed" },
];

/** Screen 4. The primary action opens the first imported project, which is where F-001 asks. That second consent should feel like a normal project open, not another scary dialog. */
export function SummaryView({
  outcome,
  queued,
  onOpenProject,
  onNextPack,
  onClose,
}: {
  outcome: ImportOutcome;
  queued: number;
  onOpenProject: (slug: string) => void;
  onNextPack: () => void;
  onClose: () => void;
}) {
  const firstProject = outcome.results.find(
    (r) =>
      r.kind === "project" &&
      (r.outcome === "added" || r.outcome === "replaced" || r.outcome === "keptBoth"),
  );

  return (
    <div className="packs-main">
      <div className="packs-scroll">
        <h1 className="packs-pack-title">
          {outcome.stoppedAt ? "Import stopped part way" : "Import complete"}
        </h1>

        {outcome.stoppedAt && (
          <div className="packs-verdict packs-verdict-bad">
            <span className="packs-verdict-icon" aria-hidden="true">
              !
            </span>
            <div className="packs-verdict-body">
              <strong>Stopped at {outcome.stoppedAt}</strong>
              Everything listed as added or replaced below is on your Mac. Nothing else was written.
            </div>
          </div>
        )}

        {GROUPS.map(({ outcome: kind, label }) => {
          const rows = outcome.results.filter((r) => r.outcome === kind);
          if (rows.length === 0) return null;
          return (
            <div className="packs-outcome-group" key={kind}>
              <div className="packs-heading">
                {label} ({rows.length})
              </div>
              {rows.map((r) => (
                <div className="packs-row" key={`${r.kind}:${r.slug}`}>
                  <span className="packs-row-main">
                    <span className="packs-row-title">{r.name}</span>
                    <span className="packs-row-detail">
                      {KIND_LABELS[r.kind].one}
                      {r.detail ? ` · ${r.detail}` : ""}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          );
        })}

        {outcome.notes.map((note) => (
          <div className="packs-note" key={note}>
            {note}
          </div>
        ))}

        {outcome.backupDir && (
          <div className="packs-note">
            What you had before was moved to a backup.{" "}
            <button
              type="button"
              className="btn"
              onClick={() => void revealInFinder(String(outcome.backupDir))}
            >
              Show backups in Finder
            </button>
          </div>
        )}
      </div>

      <div className="packs-footer">
        <div className="packs-footer-summary">
          {queued > 0 ? `${queued} more pack${queued === 1 ? "" : "s"} waiting` : ""}
        </div>
        <div className="packs-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          {queued > 0 && (
            <button type="button" className="btn" onClick={onNextPack}>
              Next pack ({queued} remaining)
            </button>
          )}
          {firstProject && (
            <button
              type="button"
              className="btn primary"
              onClick={() => onOpenProject(firstProject.slug)}
            >
              Open {firstProject.name}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
