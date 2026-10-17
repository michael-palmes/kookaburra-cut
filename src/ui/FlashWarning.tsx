import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { LoadNotice } from "./LoadNotices";

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

/** The notice for an export with flagged moments, or null when it is clean (or the tap had nothing). */
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
  const fails = issues.filter((i) => i.severity === "fail");
  const name = outcome.path.split("/").pop() ?? outcome.path;
  const lines = issues.slice(0, MAX_LINES).map((i) => {
    const seconds = Math.max(0.1, (i.endMs - i.startMs) / 1000).toFixed(1);
    const standard = i.standard === "itu" ? "ITU" : "WCAG";
    return `${i.tc} for ${seconds} s: ${i.flashesPerSecond} flashes a second over ${i.areaPct}% of the frame (${standard} ${i.type}, ${i.severity === "fail" ? "fails" : "close to the limit"})`;
  });
  if (issues.length > MAX_LINES) lines.push(`and ${issues.length - MAX_LINES} more`);
  const count = fails.length || issues.length;
  const advice = (fails[0] ?? issues[0]).hint;
  const subject = origin === "claude" ? "Claude's export" : "This export";
  return {
    tone: fails.length ? "danger" : "warning",
    title: fails.length
      ? `${subject} flashes enough to risk seizures (${count} moment${count === 1 ? "" : "s"})`
      : `${subject} comes close to the flash limits`,
    lines,
    hint: `${advice.charAt(0).toUpperCase()}${advice.slice(1)}. The report is saved beside the export as ${name}.flashes.json.`,
  };
}

export interface FlaggedExport {
  outcome: FlashOutcome;
  origin: FlashOrigin;
}

const listeners = new Set<(flagged: FlaggedExport) => void>();

/** Hears every flagged export; returns the unsubscribe. */
export function onFlaggedExport(listener: (flagged: FlaggedExport) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** After an export (the Export button's or Claude's): fetch the tap's report for that file and raise the notice when it flagged anything. A null path (a verify, whose second render Rust recorded) takes the latest report. */
export async function noteExportFlashes(
  path: string | null,
  origin: FlashOrigin = "button",
): Promise<void> {
  const outcome = await invoke<FlashOutcome | null>("export_flash_report").catch(() => null);
  if (!outcome || (path !== null && outcome.path !== path) || !flashNotice(outcome)) return;
  for (const listener of listeners) listener({ outcome, origin });
}

/** The persistent flash warning over the stage: stays until dismissed or the next flagged export replaces it. */
export function FlashWarning({ hidden }: { hidden: boolean }) {
  const [flagged, setFlagged] = useState<FlaggedExport | null>(null);
  useEffect(() => onFlaggedExport(setFlagged), []);
  const notice = flagged ? flashNotice(flagged.outcome, flagged.origin) : null;
  if (hidden || !notice) return null;
  return (
    <div className="flash-warning">
      <LoadNotice
        tone={notice.tone}
        title={notice.title}
        lines={notice.lines}
        hint={notice.hint}
        onDismiss={() => setFlagged(null)}
      />
    </div>
  );
}
