import { emit, listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

/** Per-Mac chrome preferences every window shares. Chrome only: the export path never reads them, and text size moves CSS tokens, never the canvas. */

export type TextSize = "default" | "large" | "larger";

export const TEXT_SIZES: readonly { id: TextSize; label: string; scale: number }[] = [
  { id: "default", label: "Default", scale: 1 },
  { id: "large", label: "Large", scale: 1.25 },
  { id: "larger", label: "Larger", scale: 1.5 },
];

const TEXT_SIZE_KEY = "kookaburra:text-size";
export const CHROME_PREFS_EVENT = "kookaburra://chrome-prefs-changed";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice still applies to this window for the session.
  }
}

let textSize: TextSize = parseTextSize(read(TEXT_SIZE_KEY));
const listeners = new Set<() => void>();

export function parseTextSize(value: string | null): TextSize {
  return TEXT_SIZES.find((s) => s.id === value)?.id ?? "default";
}

function applyTextSize(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (textSize === "default") delete root.dataset.textSize;
  else root.dataset.textSize = textSize;
}

function reload(): void {
  const nextSize = parseTextSize(read(TEXT_SIZE_KEY));
  if (nextSize === textSize) return;
  textSize = nextSize;
  applyTextSize();
  for (const l of listeners) l();
}

function broadcast(): void {
  for (const l of listeners) l();
  emit(CHROME_PREFS_EVENT).catch(() => {});
}

export function getTextSize(): TextSize {
  return textSize;
}

export function setTextSize(next: TextSize): void {
  textSize = next;
  write(TEXT_SIZE_KEY, next);
  applyTextSize();
  broadcast();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(subscribe, getTextSize, getTextSize);
}

let installed = false;

/** Applies the stored text size before first paint and follows changes made in any other window. */
export function installChromePrefs(): void {
  applyTextSize();
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === TEXT_SIZE_KEY) reload();
  });
  listen(CHROME_PREFS_EVENT, reload).catch(() => {});
}
