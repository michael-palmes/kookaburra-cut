import type { BridgeProgress } from "../engine/bridgeExport";
import { StopIcon } from "./Titlebar";
import type { BridgeOverlayState } from "./useBridgeExport";

/** "about 10 min left", "about 40 s left", or nothing before a rate is known. */
export function etaText(etaMs: number | null): string | null {
  if (etaMs === null || !Number.isFinite(etaMs)) return null;
  const s = Math.max(1, Math.round(etaMs / 1000));
  if (s < 90) return `about ${s} s left`;
  const m = Math.round(s / 60);
  if (m < 90) return `about ${m} min left`;
  return `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

/** The overlay's second line: what the export is doing now. */
export function bridgeStageText(p: BridgeProgress, verify: boolean): string {
  const run = verify ? ` (render ${p.run} of ${p.runs})` : "";
  switch (p.stage) {
    case "syncing":
      return "Picking up the latest changes";
    case "preparing":
      return p.prepareLabel;
    case "render": {
      const eta = etaText(p.etaMs);
      return `Frame ${p.frame} of ${p.total}${run}${eta ? `, ${eta}` : ""}`;
    }
    case "pass1":
      return "Encoding, pass 1 of 2";
    case "pass2":
      return "Encoding, pass 2 of 2";
    case "finalising":
      return `Finishing the file${run}`;
    case "hashing":
      return "Checking the file";
  }
}

function ClaudeMark() {
  return (
    <svg
      className="bridge-export-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.8v3.4M8 10.8v3.4M1.8 8h3.4M10.8 8h3.4M3.6 3.6l2.2 2.2M10.2 10.2l2.2 2.2M12.4 3.6l-2.2 2.2M5.8 10.2l-2.2 2.2" />
    </svg>
  );
}

/** Claude's export, shown over the stage with the person's own Cancel; rendered only while a bridge export runs. */
export function BridgeExportOverlay({
  state,
  onCancel,
}: {
  state: BridgeOverlayState | null;
  onCancel: () => void;
}) {
  if (!state) return null;
  const { progress, verify, cancelling } = state;
  const pct = Math.floor(progress.percent);
  const title = `Claude is ${verify ? "exporting and verifying" : "exporting"}, ${pct}%`;
  return (
    <div className="bridge-export" role="status" aria-live="polite">
      <ClaudeMark />
      <div className="bridge-export-body">
        <span className="bridge-export-title">{title}</span>
        <span className="bridge-export-detail">
          {cancelling ? "Cancelling…" : bridgeStageText(progress, verify)}
        </span>
        <span className="bridge-export-bar" aria-hidden="true">
          <span className="bridge-export-fill" style={{ width: `${pct}%` }} />
        </span>
      </div>
      <button
        type="button"
        className="btn bridge-export-cancel"
        title="Stop Claude's export; nothing is saved"
        onClick={onCancel}
        disabled={cancelling}
        aria-busy={cancelling}
      >
        {cancelling ? <span className="button-spinner" aria-hidden="true" /> : <StopIcon />}
        {cancelling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  );
}
