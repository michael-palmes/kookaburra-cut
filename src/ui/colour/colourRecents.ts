/** Recently used colours, localStorage-backed like the font picker's recents. */

const RECENTS_KEY = "kookaburra:colour-recents";
const CAP = 10;

export function loadColourRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string").slice(0, CAP)
      : [];
  } catch {
    return [];
  }
}

export function rememberColourPick(hex: string): void {
  const lower = hex.toLowerCase();
  const rest = loadColourRecents().filter((r) => r.toLowerCase() !== lower);
  localStorage.setItem(RECENTS_KEY, JSON.stringify([lower, ...rest].slice(0, CAP)));
}

/** The spectrum costs ~190px, so it stays folded until someone asks for it, then stays unfolded for every picker after. */
const SPECTRUM_KEY = "kookaburra:colour-spectrum-open";

export function loadSpectrumOpen(): boolean {
  try {
    return localStorage.getItem(SPECTRUM_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberSpectrumOpen(open: boolean): void {
  try {
    localStorage.setItem(SPECTRUM_KEY, open ? "1" : "0");
  } catch {
    // A blocked localStorage costs the preference, never the picker.
  }
}
