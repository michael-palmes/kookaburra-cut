import { useSyncExternalStore } from "react";

/** Live modifier state, one window listener set for the whole app. DOM field names, so a snapshot drops straight into the existing readers (CameraToolOverlay's `modifierTool`) and the overlay and the pointer router can never disagree about what is held. */
export interface ModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const NONE: ModifierState = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

/** Project the four flags off any event-shaped object. */
export function modifiersFrom(e: ModifierState): ModifierState {
  return {
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
  };
}

let state: ModifierState = NONE;
const listeners = new Set<() => void>();

function apply(next: ModifierState): void {
  if (
    next.metaKey === state.metaKey &&
    next.ctrlKey === state.ctrlKey &&
    next.altKey === state.altKey &&
    next.shiftKey === state.shiftKey
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

const onKey = (e: KeyboardEvent) => apply(modifiersFrom(e));
// A pointer-down resyncs, so a drag that starts after a missed keyup (window focus changes swallow them) begins from truth.
const onPointerDown = (e: PointerEvent) => apply(modifiersFrom(e));
const onBlur = () => apply(NONE);

function attach(): void {
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("blur", onBlur);
}

function detach(): void {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKey);
  window.removeEventListener("pointerdown", onPointerDown, { capture: true });
  window.removeEventListener("blur", onBlur);
  apply(NONE);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

/** Imperative read, for code outside React (event handlers, the router's latch). */
export function modifierSnapshot(): ModifierState {
  return state;
}

/** Live modifier flags. The snapshot object is replaced only when a flag actually changes, so holding a letter key re-renders nothing. */
export function useModifierKeys(): ModifierState {
  return useSyncExternalStore(subscribe, modifierSnapshot, modifierSnapshot);
}
