import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { WarningIcon } from "./LoadNotices";

/** One flagged stretch from the export's flash tap (`flashes.rs` FlashIssue). */
export interface FlashIssue {
  type: string;
  standard: string;
  severity: "fail" | "warn" | string;
  startMs: number;
  endMs: number;
  tc: string;
  flashesPerSecond: number;
  areaPct: number;
  hint: string;
}

/** `export_flash_report`: the tap's verdict on the last finished export. */
export interface FlashOutcome {
  path: string;
  report: { ok: boolean; issues: FlashIssue[] } | null;
  unavailable: string | null;
}

/** Who ran the export a notice is about: the Export button, or Claude through `kb export`. */
export type FlashOrigin = "button" | "claude";

const MAX_LINES = 5;

const STANDARD_NAMES: Record<string, string> = { wcag: "WCAG 2.3.1", itu: "ITU-R BT.1702" };

/** One flagged moment: the same stretch judged by one or both standards. */
interface FlashMoment {
  issue: FlashIssue;
  standards: string[];
  areaPct: number;
}

/** The standards report the same stretch separately; one line per stretch reads them together. */
function flashMoments(issues: FlashIssue[]): FlashMoment[] {
  const moments = new Map<string, FlashMoment>();
  for (const issue of issues) {
    const key = `${issue.tc}|${issue.type}|${issue.severity}`;
    const name = STANDARD_NAMES[issue.standard] ?? issue.standard.toUpperCase();
    const moment = moments.get(key);
    if (moment) {
      if (!moment.standards.includes(name)) moment.standards.push(name);
      moment.areaPct = Math.max(moment.areaPct, issue.areaPct);
    } else {
      moments.set(key, { issue, standards: [name], areaPct: issue.areaPct });
    }
  }
  const order = Object.values(STANDARD_NAMES);
  for (const moment of moments.values()) {
    moment.standards.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  }
  return [...moments.values()];
}

function momentLine({ issue, standards, areaPct }: FlashMoment): string {
  const seconds = Math.max(0.1, (issue.endMs - issue.startMs) / 1000).toFixed(1);
  const area = areaPct >= 99.5 ? "the whole frame" : `${areaPct}% of the frame`;
  const kind = issue.type === "general" ? "" : `${issue.type} flash, `;
  const verdict = issue.severity === "fail" ? "fails" : "close to the limit of";
  return `${issue.tc}, ${seconds} s: ${issue.flashesPerSecond} flashes a second over ${area} (${kind}${verdict} ${standards.join(" and ")})`;
}

/** The export card's flash section for an export with flagged moments, or null when it is clean (or the tap had nothing). */
export function flashNotice(
  outcome: FlashOutcome | null,
  origin: FlashOrigin = "button",
): {
  tone: "danger" | "warning";
  title: string;
  lines: string[];
  hint: string;
} | null {
  const issues = outcome?.report?.issues ?? [];
  if (!outcome || issues.length === 0) return null;
  const moments = flashMoments(issues);
  const fails = moments.filter((m) => m.issue.severity === "fail");
  const name = outcome.path.split("/").pop() ?? outcome.path;
  const lines = moments.slice(0, MAX_LINES).map(momentLine);
  if (moments.length > MAX_LINES) lines.push(`and ${moments.length - MAX_LINES} more`);
  const count = fails.length || moments.length;
  const advice = (fails[0] ?? moments[0]).issue.hint;
  const subject = origin === "claude" ? "Claude's export" : "Your cut";
  return {
    tone: fails.length ? "danger" : "warning",
    title: fails.length
      ? `${subject} is ready, but it flashes enough to risk seizures (${count} moment${count === 1 ? "" : "s"})`
      : `${subject} is ready, but it comes close to the flash limits`,
    lines,
    hint: `${advice.charAt(0).toUpperCase()}${advice.slice(1)}. The report is saved beside the export as ${name}.flashes.json.`,
  };
}

export interface FlaggedExport {
  outcome: FlashOutcome;
  origin: FlashOrigin;
}

const listeners = new Set<(flagged: FlaggedExport | null) => void>();

/** Hears every finished export: the flagged one, or null for a clean one (which clears the card); returns the unsubscribe. */
export function onFlaggedExport(listener: (flagged: FlaggedExport | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A new export, stills or verify run starting: the previous card goes, so a failed or cancelled run never shows an older film's result. */
export function clearExportCard(): void {
  for (const listener of listeners) listener(null);
}

/** After every finished export (the Export button's or Claude's): fetch the tap's report for that file and raise the export card when it flagged anything, or clear an older card when it did not. A null path (a verify, whose second render Rust recorded) takes the latest report. True when the card took over from the success toast. */
export async function noteExportFlashes(
  path: string | null,
  origin: FlashOrigin = "button",
): Promise<boolean> {
  const outcome = await invoke<FlashOutcome | null>("export_flash_report").catch(() => null);
  const flagged =
    outcome && (path === null || outcome.path === path) && flashNotice(outcome) ? outcome : null;
  for (const listener of listeners) listener(flagged ? { outcome: flagged, origin } : null);
  return flagged !== null;
}

const REVEAL_ICON = (
  <svg
    className="export-card-action-icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M1.8 4.2a1 1 0 0 1 1-1h3.3l1.4 1.6h5.7a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z" />
  </svg>
);

/** The export result for a flagged film, in the toast corner: ready, Show in Finder, then the flagged moments and the fix. Stays until dismissed or the next export replaces or clears it. */
export function FlashWarning({
  hidden,
  onReveal,
}: {
  hidden: boolean;
  onReveal: (path: string) => void;
}) {
  const [flagged, setFlagged] = useState<FlaggedExport | null>(null);
  useEffect(() => onFlaggedExport(setFlagged), []);
  const notice = flagged ? flashNotice(flagged.outcome, flagged.origin) : null;
  if (hidden || !notice) return null;
  return (
    <div
      className={`export-card export-card-${notice.tone}`}
      role={notice.tone === "danger" ? "alert" : "status"}
    >
      <div className="export-card-head">
        <WarningIcon />
        <p className="export-card-title">{notice.title}</p>
        <button
          type="button"
          className="toast-close"
          aria-label="Dismiss"
          onClick={() => setFlagged(null)}
        >
          ×
        </button>
      </div>
      <div className="export-card-actions">
        <button
          type="button"
          className="toast-action export-card-action"
          onClick={() => {
            setFlagged(null);
            onReveal(flagged?.outcome.path ?? "");
          }}
        >
          {REVEAL_ICON}
          Show in Finder
        </button>
      </div>
      <ul className="export-card-list">
        {notice.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="export-card-hint">{notice.hint}</p>
    </div>
  );
}
