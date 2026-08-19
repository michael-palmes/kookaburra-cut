import { useEffect, useState } from "react";
import { formatBytes } from "../engine/appCache";
import {
  deleteUnusedMedia,
  fsUrl,
  type MediaDeleteFailure,
  type MediaMeta,
  type UnusedAsset,
  unusedMedia,
} from "../engine/media";
import {
  allUnusedRels,
  toggleUnusedRel,
  unusedOutcome,
  unusedSummary,
  unusedTotals,
} from "./unusedMediaPlan";
import { useEscapeClose } from "./useEscapeClose";

/** The bulk sweep behind "Delete unused…": every media file nothing in the project points at, ticked, with a running total. One confirm trashes them through the same per-file guard a single card's Delete uses, so a file another window started using since the sheet opened is refused and named rather than swallowed. Management surfaces only; a picker's job is choosing a file. */
export function UnusedMediaSheet({
  slug,
  metas,
  editedRels,
  onDeleted,
  onClose,
}: {
  slug: string;
  /** Posters the grid has already generated, keyed by rel; a row without one draws the empty thumb box and fills in as the grid's pass reaches it. */
  metas: Readonly<Record<string, MediaMeta>>;
  /** Rels that are an edit's rendered output, chipped so a re-renderable file is obvious before it goes. */
  editedRels: ReadonlySet<string>;
  /** At least one file was trashed: the host re-scans its grid. */
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<UnusedAsset[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<readonly MediaDeleteFailure[]>([]);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEscapeClose(onClose, !busy);

  useEffect(() => {
    let cancelled = false;
    unusedMedia(slug)
      .then((list) => {
        if (cancelled) return;
        setAssets(list);
        setSelected(allUnusedRels(list));
      })
      .catch((e) => {
        if (cancelled) return;
        setAssets([]);
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const totals = unusedTotals(assets ?? [], selected);
  const allTicked = assets !== null && assets.length > 0 && totals.count === assets.length;

  const sweep = async () => {
    const rels = (assets ?? []).filter((asset) => selected.has(asset.rel)).map((a) => a.rel);
    if (rels.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    setFailures([]);
    setProgress({ done: 0, total: rels.length });
    const refused = await deleteUnusedMedia(slug, rels, (done, total) =>
      setProgress({ done, total }),
    );
    const deleted = rels.length - refused.length;
    if (deleted > 0) onDeleted();
    if (refused.length === 0) {
      onClose();
      return;
    }
    // The trashed rows are gone; re-listing leaves exactly what refused, still ticked.
    setFailures(refused);
    setOutcome(unusedOutcome(deleted, refused));
    setBusy(false);
    setProgress(null);
    try {
      const list = await unusedMedia(slug);
      setAssets(list);
      setSelected(allUnusedRels(list));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Delete unused media">
      <div className="modal unused-media-modal">
        <div className="modal-title-row">
          <h2 className="modal-title">Delete unused media</h2>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          />
        </div>
        <p className="modal-hint">
          Nothing in this project points at these files. They are all ticked; untick anything you
          want to keep.
        </p>
        {assets === null ? (
          <p className="muted">Checking what's used…</p>
        ) : assets.length === 0 ? (
          <p className="muted">Every file in this project is in use.</p>
        ) : (
          <>
            <div className="unused-list">
              {assets.map((asset) => {
                const name = asset.rel.replace(/^assets\//, "");
                const poster = metas[asset.rel]?.posterPath;
                return (
                  <label className="unused-row" key={asset.rel}>
                    <input
                      type="checkbox"
                      checked={selected.has(asset.rel)}
                      disabled={busy}
                      onChange={() => setSelected(toggleUnusedRel(selected, asset.rel))}
                    />
                    <span className="unused-thumb">
                      {poster && <img src={fsUrl(poster)} alt="" draggable={false} />}
                    </span>
                    <span className="unused-row-main">
                      <span className="unused-row-name" title={name}>
                        {name}
                      </span>
                      <span className="unused-row-detail">
                        {asset.kind === "video" ? "Video" : "Image"}
                        {editedRels.has(asset.rel) && " · Edit render"}
                      </span>
                    </span>
                    <span className="unused-row-size">{formatBytes(asset.bytes)}</span>
                  </label>
                );
              })}
            </div>
            <button
              type="button"
              className="btn btn-small unused-tick-all"
              disabled={busy}
              onClick={() => setSelected(allTicked ? new Set() : allUnusedRels(assets))}
            >
              {allTicked ? "Untick all" : "Tick all"}
            </button>
          </>
        )}
        {error && <p className="modal-error">{error}</p>}
        {outcome && (
          <p className="modal-error">
            {outcome}
            {failures.map((f) => (
              <span className="unused-failure" key={f.rel}>
                {f.message}
              </span>
            ))}
          </p>
        )}
        <div className="modal-actions">
          <span className="unused-summary" aria-live="polite">
            {unusedSummary(totals)}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || totals.count === 0}
            onClick={() => void sweep()}
          >
            {busy && progress
              ? `Moving ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
              : "Move to Trash"}
          </button>
        </div>
      </div>
    </div>
  );
}
