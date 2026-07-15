import { create } from "zustand";

/** The pending F-001 consent request: `loadProject` blocks on `resolve`, the TrustGateModal answers it. Chrome-only state; the export path never reads it (autorun auto-trusts before a request is ever created). */
export interface TrustRequest {
  slug: string;
  /** Manifest display name, for the modal copy. */
  name: string;
  resolve: (allowed: boolean) => void;
}

interface TrustState {
  pending: TrustRequest | null;
  /** Queues a consent request and resolves with the user's answer; concurrent requests for the same slug (the fingerprint poll can re-enter `loadProject` while the modal is up) share one modal. */
  request: (slug: string, name: string) => Promise<boolean>;
  answer: (allowed: boolean) => void;
}

/** In-flight request per slug, so a re-entrant load awaits the existing modal instead of replacing it. */
const inflight = new Map<string, Promise<boolean>>();

export const useTrustStore = create<TrustState>((set, get) => ({
  pending: null,
  request: (slug, name) => {
    const existing = inflight.get(slug);
    if (existing) return existing;
    const promise = new Promise<boolean>((resolve) => {
      set({ pending: { slug, name, resolve } });
    }).finally(() => inflight.delete(slug));
    inflight.set(slug, promise);
    return promise;
  },
  answer: (allowed) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(allowed);
  },
}));
