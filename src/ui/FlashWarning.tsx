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

const MAX_LINES = 5;

/** The notice for an export with flagged moments, or null when it is clean (or the tap had nothing). */
export function flashNotice(outcome: FlashOutcome | null): {
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
  return {
    tone: fails.length ? "danger" : "warning",
    title: fails.length
      ? `This export flashes enough to risk seizures (${count} moment${count === 1 ? "" : "s"})`
      : "This export comes close to the flash limits",
    lines,
    hint: `${advice.charAt(0).toUpperCase()}${advice.slice(1)}. The report is saved beside the export as ${name}.flashes.json.`,
  };
}

const listeners = new Set<(outcome: FlashOutcome) => void>();

/** After the Export button's export: fetch the tap's report for that file and raise the notice when it flagged anything. */
export async function noteExportFlashes(path: string): Promise<void> {
  const outcome = await invoke<FlashOutcome | null>("export_flash_report").catch(() => null);
  if (!outcome || outcome.path !== path || !flashNotice(outcome)) return;
  for (const listener of listeners) listener(outcome);
}

/** The persistent flash warning over the stage: stays until dismissed or the next flagged export replaces it. */
export function FlashWarning({ hidden }: { hidden: boolean }) {
  const [outcome, setOutcome] = useState<FlashOutcome | null>(null);
  useEffect(() => {
    listeners.add(setOutcome);
    return () => {
      listeners.delete(setOutcome);
    };
  }, []);
  const notice = flashNotice(outcome);
  if (hidden || !notice) return null;
  return (
    <div className="flash-warning">
      <LoadNotice
        tone={notice.tone}
        title={notice.title}
        lines={notice.lines}
        hint={notice.hint}
        onDismiss={() => setOutcome(null)}
      />
    </div>
  );
}
