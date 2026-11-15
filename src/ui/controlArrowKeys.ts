/** Remote-control clients can send arrows as the old Mac control codes under another keycode, which WebKit types into the focused field. */
const ARROW_CODES: Record<string, string> = {
  "\u001c": "ArrowLeft",
  "\u001d": "ArrowRight",
  "\u001e": "ArrowUp",
  "\u001f": "ArrowDown",
};

export function arrowForControlCode(key: string): string | undefined {
  return ARROW_CODES[key];
}

type TextControl = Pick<
  HTMLInputElement,
  "value" | "selectionStart" | "selectionEnd" | "selectionDirection" | "setSelectionRange"
> & { tagName: string };

function textControl(target: EventTarget | null): TextControl | null {
  const el = target as Partial<TextControl> | null;
  if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return null;
  return typeof el.selectionStart === "number" ? (el as TextControl) : null;
}

function lineStart(value: string, at: number): number {
  return value.lastIndexOf("\n", at - 1) + 1;
}

function lineEnd(value: string, at: number): number {
  const end = value.indexOf("\n", at);
  return end === -1 ? value.length : end;
}

function vertical(value: string, at: number, up: boolean): number {
  const start = lineStart(value, at);
  const column = at - start;
  if (up) {
    if (start === 0) return 0;
    const prev = lineStart(value, start - 1);
    return Math.min(prev + column, start - 1);
  }
  const end = lineEnd(value, at);
  if (end === value.length) return value.length;
  return Math.min(end + 1 + column, lineEnd(value, end + 1));
}

/** The caret move the arrow would have made: by character, ⌘ to the line's ends, ⇧ to extend. */
export function moveCaret(el: TextControl, arrow: string, shift: boolean, meta: boolean): void {
  const { value } = el;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  const backward = el.selectionDirection === "backward";
  const anchor = backward ? end : start;
  const focus = backward ? start : end;
  const left = arrow === "ArrowLeft";
  const up = arrow === "ArrowUp";
  let next: number;
  if (arrow === "ArrowLeft" || arrow === "ArrowRight") {
    if (meta) next = left ? lineStart(value, focus) : lineEnd(value, focus);
    else if (!shift && start !== end) next = left ? start : end;
    else next = Math.max(0, Math.min(value.length, focus + (left ? -1 : 1)));
  } else if (meta) {
    next = up ? 0 : value.length;
  } else {
    next = vertical(value, focus, up);
  }
  if (!shift) el.setSelectionRange(next, next);
  else
    el.setSelectionRange(
      Math.min(anchor, next),
      Math.max(anchor, next),
      next < anchor ? "backward" : "forward",
    );
}

/** Replays the arrow as itself, so lanes and fields get the key they expect, and nothing is typed. */
export function normaliseControlArrow(e: KeyboardEvent): void {
  const arrow = arrowForControlCode(e.key);
  if (!arrow) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const target = e.target ?? document;
  const replay = new KeyboardEvent("keydown", {
    key: arrow,
    code: arrow,
    bubbles: true,
    cancelable: true,
    composed: true,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
  });
  target.dispatchEvent(replay);
  const field = textControl(target);
  if (field && !replay.defaultPrevented) moveCaret(field, arrow, e.shiftKey, e.metaKey);
}

let installed = false;

export function installControlArrowKeys(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", normaliseControlArrow, true);
}
