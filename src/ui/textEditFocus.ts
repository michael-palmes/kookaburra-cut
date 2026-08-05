/** ⌘Z ownership for focused text controls: WebKit's in-field undo may only win while a control holds UNCOMMITTED typing. A drag-scrubbed number field, a slider or a just-committed input keeps focus with nothing to undo, and would otherwise swallow the app's own undo (and go stale when one lands). Typing is tracked from real `input` events (React's programmatic value writes fire none) and cleared when the control loses focus. */

interface EditableLike {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** True for controls with their own text undo stack: text-entry inputs, textareas and contenteditable hosts, never sliders, colour wells, checkboxes or selects. */
export function isEditableTextTarget(el: EditableLike | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && TEXT_INPUT_TYPES.has(el.type ?? "text");
}

let typing: Element | null = null;

if (typeof document !== "undefined") {
  document.addEventListener(
    "input",
    (e) => {
      const el = e.target as (Element & EditableLike) | null;
      if (el && isEditableTextTarget(el)) typing = el;
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.target === typing) typing = null;
    },
    true,
  );
}

/** True while `el` is focused AND holds typing it has not committed yet. */
export function isTypingIn(el: Element | null): boolean {
  return !!el && el === typing && document.activeElement === el;
}

/** True while the focused control is mid-edit, so the app's own undo must stand aside. */
export function hasPendingTextEdit(): boolean {
  return isTypingIn(document.activeElement);
}
