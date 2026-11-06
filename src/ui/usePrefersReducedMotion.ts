import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | undefined {
  return typeof window === "undefined" ? undefined : window.matchMedia?.(QUERY);
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  list?.addEventListener?.("change", onChange);
  return () => list?.removeEventListener?.("change", onChange);
}

/** The system's Reduce motion setting, live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? false,
    () => false,
  );
}
