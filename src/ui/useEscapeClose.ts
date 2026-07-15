import { useEffect, useRef } from "react";

/** Escape-closes the current top-most layer: a module-level stack arbitrates so one Escape closes exactly one layer, innermost first; listeners run in the capture phase so App-level key handling never sees an Escape meant for a layer; `enabled` gates registration so a busy wizard isn't dismissable mid-scaffold. */
const stack: symbol[] = [];

export function useEscapeClose(onClose: () => void, enabled = true): void {
  // The latest close handler without re-registering; stack position must be stable across handler identity changes.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const id = Symbol("escape-layer");
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (stack[stack.length - 1] !== id) return; // an inner layer owns this Escape
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [enabled]);
}
