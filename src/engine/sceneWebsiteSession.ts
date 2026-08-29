import { create } from "zustand";
import type { WebsiteViewStateName } from "./sceneWebsiteNative";

export interface PendingWebsiteOrigin {
  origin: string;
  loopback: boolean;
  initial: boolean;
}

export interface SceneWebsiteSession {
  viewId: string | null;
  state: WebsiteViewStateName | "idle";
  active: boolean;
  focused: boolean;
  currentOrigin: string | null;
  pendingOrigin: PendingWebsiteOrigin | null;
  error: string | null;
}

const EMPTY_SESSION: SceneWebsiteSession = {
  viewId: null,
  state: "idle",
  active: false,
  focused: false,
  currentOrigin: null,
  pendingOrigin: null,
  error: null,
};

export function sceneWebsiteKey(projectId: string, sceneStem: string): string {
  return `${projectId}\u0000${sceneStem}`;
}

interface SceneWebsiteSessionStore {
  sessions: Record<string, SceneWebsiteSession>;
  patch: (key: string, patch: Partial<SceneWebsiteSession>) => void;
  clear: (key: string) => void;
}

export const useSceneWebsiteSessionStore = create<SceneWebsiteSessionStore>((set) => ({
  sessions: {},
  patch: (key, patch) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: { ...(state.sessions[key] ?? EMPTY_SESSION), ...patch },
      },
    })),
  clear: (key) =>
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[key];
      return { sessions };
    }),
}));

export function sceneWebsiteSession(key: string): SceneWebsiteSession {
  return useSceneWebsiteSessionStore.getState().sessions[key] ?? EMPTY_SESSION;
}

export function websiteSessionClaimsStage(session: SceneWebsiteSession | undefined): boolean {
  return session?.active === true || session?.pendingOrigin != null;
}

export const WEBSITE_ACTIVATE_REQUEST_EVENT = "kookaburra:website-activate-request";
export const WEBSITE_DEACTIVATE_REQUEST_EVENT = "kookaburra:website-deactivate-request";

export function requestSceneWebsiteActivation(key: string): void {
  window.dispatchEvent(new CustomEvent(WEBSITE_ACTIVATE_REQUEST_EVENT, { detail: { key } }));
}

export function requestSceneWebsiteDeactivation(key: string): void {
  window.dispatchEvent(new CustomEvent(WEBSITE_DEACTIVATE_REQUEST_EVENT, { detail: { key } }));
}
