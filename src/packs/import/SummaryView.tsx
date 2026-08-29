import { revealInFinder } from "../../engine/packs";
import type { TerminalReviewRow } from "../terminalReview";
import { type ImportOutcome, type ItemOutcome, KIND_LABELS } from "../types";
import type { WebsiteReviewRow } from "../websiteReview";

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
  terminals,
  websites,
  queued,
  onOpenProject,
  onNextPack,
  onClose,
}: {
  outcome: ImportOutcome;
  terminals: TerminalReviewRow[];
  websites: WebsiteReviewRow[];
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

        {terminals.length > 0 && (
          <div className="packs-verdict packs-verdict-warn">
            <span className="packs-verdict-icon" aria-hidden="true">
              !
            </span>
            <div className="packs-verdict-body">
              <strong>Terminal scenes came with pre-typed commands</strong>
              Nothing runs on its own: a pre-typed command only runs when you press Enter on it.
              Review these before presenting, since they were written by the pack's author.
              {terminals.map((row) => (
                <div className="packs-terminal-review-row" key={`${row.project}:${row.file}`}>
                  <span className="packs-verdict-note">
                    {row.project} · {row.scene}
                    {row.startPath ? ` · opens at ${row.startPath}` : ""}
                  </span>
                  {row.command && <code className="packs-terminal-command">{row.command}</code>}
                </div>
              ))}
            </div>
          </div>
        )}

        {websites.length > 0 && (
          <div className="packs-verdict packs-verdict-warn">
            <span className="packs-verdict-icon" aria-hidden="true">
              !
            </span>
            <div className="packs-verdict-body">
              <strong>Website scenes request network access</strong>
              Nothing has loaded and no approval travelled with the pack. Each origin asks for local
              approval before its first request.
              {websites.map((row) => (
                <div className="packs-terminal-review-row" key={`${row.project}:${row.file}`}>
                  <span className="packs-verdict-note">
                    {row.project} · {row.scene}
                  </span>
                  {row.origins.map((origin) => (
                    <code className="packs-terminal-command" key={origin.origin}>
                      {origin.origin}
                      {origin.loopback ? " · local address, session approval only" : ""}
                    </code>
                  ))}
                </div>
              ))}
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
