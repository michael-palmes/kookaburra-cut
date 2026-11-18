import type { ExportProgress } from "../engine/exporter";

export function exportVerbFor(kind: "video" | "pdf" | "png-zip"): string {
  return kind === "pdf" ? "Exporting PDF" : kind === "png-zip" ? "Exporting images" : "Exporting";
}

/** What the export's live region says: one line per 10% step, so VoiceOver hears the advance without a running count (WCAG 4.1.3). */
export function exportProgressAnnouncement(
  progress: ExportProgress | null,
  verb = "Exporting",
): string {
  if (!progress) return `${verb}, getting ready`;
  if (progress.stage === "pass1") return "Encoding, pass 1 of 2";
  if (progress.stage === "pass2") return "Encoding, pass 2 of 2";
  const pct = progress.total > 0 ? (progress.frame / progress.total) * 100 : 0;
  return `${verb} ${Math.min(100, Math.floor(pct / 10) * 10)}%`;
}
