import { useEffect, useRef, useState } from "react";

export const BLOCKING_MODAL_SELECTOR = ".modal-overlay";

interface OverlayQueryRoot {
  querySelector: (selectors: string) => unknown;
}

export function hasBlockingModalOverlay(root: OverlayQueryRoot): boolean {
  return root.querySelector(BLOCKING_MODAL_SELECTOR) !== null;
}

export function useBlockingModalOverlay() {
  const initial = typeof document !== "undefined" && hasBlockingModalOverlay(document);
  const presentRef = useRef(initial);
  const [present, setPresent] = useState(initial);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const sync = () => {
      const next = hasBlockingModalOverlay(document);
      presentRef.current = next;
      setPresent((current) => (current === next ? current : next));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  return { present, presentRef };
}
