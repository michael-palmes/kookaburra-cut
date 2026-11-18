import { emit, listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { installControlArrowKeys } from "./controlArrowKeys";

/** Per-Mac chrome preferences every window shares: text size and single-key shortcuts. Chrome only: the export path never reads them, and text size moves CSS tokens, never the canvas. */

export type TextSize = "default" | "large" | "larger" | "largest";

export const TEXT_SIZES: readonly { id: TextSize; label: string; scale: number }[] = [
  { id: "default", label: "Default", scale: 1 },
  { id: "large", label: "Large", scale: 1.25 },
  { id: "larger", label: "Larger", scale: 1.5 },
  { id: "largest", label: "Largest", scale: 2 },
];

const TEXT_SIZE_KEY = "kookaburra:text-size";
const SINGLE_KEY_KEY = "kookaburra:single-key-shortcuts";
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
let singleKey = read(SINGLE_KEY_KEY) !== "0";
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

interface ChromePrefsPayload {
  textSize: TextSize;
  singleKey: boolean;
}

/** Another window's change: the payload carries the values, since its localStorage write can reach this web view after the event does. */
export function applyChromePrefs(next: Partial<ChromePrefsPayload> | null | undefined): void {
  adopt(
    parseTextSize(next?.textSize ?? textSize),
    typeof next?.singleKey === "boolean" ? next.singleKey : singleKey,
  );
}

function reload(): void {
  adopt(parseTextSize(read(TEXT_SIZE_KEY)), read(SINGLE_KEY_KEY) !== "0");
}

function adopt(nextSize: TextSize, nextSingle: boolean): void {
  if (nextSize === textSize && nextSingle === singleKey) return;
  textSize = nextSize;
  singleKey = nextSingle;
  applyTextSize();
  for (const l of listeners) l();
}

function broadcast(): void {
  for (const l of listeners) l();
  const payload: ChromePrefsPayload = { textSize, singleKey };
  emit(CHROME_PREFS_EVENT, payload).catch(() => {});
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

/** Whether shortcuts that are one character key with no modifier may fire (WCAG 2.1.4). */
export function singleKeyShortcutsEnabled(): boolean {
  return singleKey;
}

export function setSingleKeyShortcuts(enabled: boolean): void {
  singleKey = enabled;
  write(SINGLE_KEY_KEY, enabled ? "1" : "0");
  broadcast();
}

/** True for a keydown that is one printable character with no ⌘, ⌃ or ⌥ (Shift still counts as single). */
export function isSingleCharacterKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
): boolean {
  return e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey;
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  return (
    el.isContentEditable === true ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/** Every single-key shortcut listens on window in the bubble phase, so stopping the key at document turns them all off at once while focused controls and fields still get it. */
export function guardSingleKeyShortcuts(e: KeyboardEvent): void {
  if (singleKey || !isSingleCharacterKey(e) || isEditable(e.target)) return;
  e.stopPropagation();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(subscribe, getTextSize, getTextSize);
}

export function useSingleKeyShortcuts(): boolean {
  return useSyncExternalStore(subscribe, singleKeyShortcutsEnabled, singleKeyShortcutsEnabled);
}

let installed = false;

/** Applies the stored text size before first paint and follows changes made in any other window. */
export function installChromePrefs(): void {
  applyTextSize();
  if (installed || typeof window === "undefined") return;
  installed = true;
  installControlArrowKeys();
  document.addEventListener("keydown", guardSingleKeyShortcuts);
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === TEXT_SIZE_KEY || e.key === SINGLE_KEY_KEY) reload();
  });
  listen<ChromePrefsPayload>(CHROME_PREFS_EVENT, (e) => applyChromePrefs(e.payload)).catch(
    () => {},
  );
}
