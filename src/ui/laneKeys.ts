/** The keyboard model both timelines share (the animation lanes and the video editor's track): one Tab stop per lane with roving focus over its items, and every key a modifier, arrow, Enter, Space, Delete, Escape or ⇧F10, so the single-key shortcuts switch never touches it. Edits go through the same functions the drags call; this file only reads keys. */

import { opensContextMenu } from "./ContextMenu";

/** ⇧ with a move or trim key steps this many frames, as ⇧ with the frame-step arrows does. */
export const LARGE_STEP_FRAMES = 10;

export type LaneKeyIntent =
  | { kind: "focus"; to: "prev" | "next" | "first" | "last" }
  | { kind: "lane"; step: -1 | 1 }
  | { kind: "move"; frames: number }
  | { kind: "trim"; edge: "start" | "end"; frames: number }
  | { kind: "select" }
  | { kind: "delete" }
  | { kind: "menu" }
  | { kind: "escape" };

type KeyInput = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey">;

/** What a key does to a focused lane item. ⌃ is left to macOS (it owns ⌃ arrows), and ⌘ alone with Up or Down stays free. */
export function laneKeyIntent(e: KeyInput): LaneKeyIntent | null {
  if (opensContextMenu(e)) return { kind: "menu" };
  if (e.ctrlKey) return null;
  const plain = !e.metaKey && !e.altKey;
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowRight": {
      const sign = e.key === "ArrowLeft" ? -1 : 1;
      const frames = sign * (e.shiftKey ? LARGE_STEP_FRAMES : 1);
      if (e.metaKey && e.altKey) return { kind: "trim", edge: "end", frames };
      if (e.altKey) return { kind: "trim", edge: "start", frames };
      if (e.metaKey) return { kind: "move", frames };
      if (e.shiftKey) return null;
      return { kind: "focus", to: sign < 0 ? "prev" : "next" };
    }
    case "ArrowUp":
    case "ArrowDown":
      return plain && !e.shiftKey ? { kind: "lane", step: e.key === "ArrowUp" ? -1 : 1 } : null;
    case "Home":
    case "End":
      return plain && !e.shiftKey
        ? { kind: "focus", to: e.key === "Home" ? "first" : "last" }
        : null;
    case "Enter":
    case " ":
      return plain && !e.shiftKey ? { kind: "select" } : null;
    case "Delete":
    case "Backspace":
      return plain ? { kind: "delete" } : null;
    case "Escape":
      return { kind: "escape" };
    default:
      return null;
  }
}

/** The item a focus intent lands on, held at the ends (a lane does not wrap, as a timeline does not). */
export function rovingIndex(
  current: number,
  count: number,
  to: "prev" | "next" | "first" | "last",
): number {
  if (count <= 0) return -1;
  const at = Math.min(count - 1, Math.max(0, current));
  switch (to) {
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "prev":
      return Math.max(0, at - 1);
    case "next":
      return Math.min(count - 1, at + 1);
  }
}

/** The roving item to keep as the lane's Tab stop: the one last focused while it still exists, else the selected one, else the first. */
export function rovingStop(
  ids: readonly string[],
  focused: string | null,
  selected: string | null,
): string | null {
  if (focused !== null && ids.includes(focused)) return focused;
  if (selected !== null && ids.includes(selected)) return selected;
  return ids[0] ?? null;
}

/** Move focus to the lane above or below: its roving item, or the lane itself when it has none. False when there is no lane that way. */
export function focusAdjacentLane(
  lanes: readonly HTMLElement[],
  from: HTMLElement,
  step: -1 | 1,
): boolean {
  const at = lanes.findIndex((lane) => lane.contains(from));
  const target = at < 0 ? undefined : lanes[at + step];
  if (!target) return false;
  const item = target.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
  (item ?? target).focus({ preventScroll: true });
  return true;
}

/** The ring a focused item draws when the global `:focus-visible` rule is overridden by a lane outline (the near diamond). */
export const LANE_FOCUS_RING = {
  outline: "2px solid var(--focus-ring)",
  outlineOffset: "3px",
} as const;

/** A polite live region only re-reads changed text, so a repeat of the same message toggles a trailing no-break space. */
export function nextAnnouncement(previous: string, message: string): string {
  return previous === message ? `${message} ` : message;
}
