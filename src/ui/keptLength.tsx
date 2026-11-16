import { useState } from "react";
import { formatSceneLengthMs } from "./durationText";

/** Spoken, never shown, when a typed scene length does not parse and the field keeps its length (WCAG 3.3.3). */
export function keptLengthNote(ms: number): string {
  return `Duration kept at ${formatSceneLengthMs(ms)}`;
}

/** The one revert note every scene length field shares: `keep` on a rejected entry, `clear` on the next keystroke so a repeat is spoken again. */
export function useKeptLength() {
  const [note, setNote] = useState("");
  return {
    note,
    keep: (ms: number) => setNote(keptLengthNote(ms)),
    clear: () => setNote(""),
  };
}

/** Keep this mounted while the field comes and goes: a live region only speaks changes it was already in the page for. */
export function KeptLengthNote({ note }: { note: string }) {
  return (
    <span className="visually-hidden" aria-live="polite">
      {note}
    </span>
  );
}
