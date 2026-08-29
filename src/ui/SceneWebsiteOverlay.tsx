import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import {
  type LoadedProject,
  sceneFileStem,
  workspaceProjectPath,
  workspaceSlug,
} from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { resolveSceneWebsite, sceneWebsiteLayout } from "../engine/sceneWebsite";
import {
  grantWebsiteOrigin,
  hideWebsite,
  openWebsite,
  performWebsiteAction,
  resumeWebsiteNavigation,
  setWebsiteBounds,
  showWebsite,
  WEBSITE_FOCUS_EVENT,
  WEBSITE_ORIGIN_REQUEST_EVENT,
  WEBSITE_STATE_EVENT,
  type WebsiteFocusEvent,
  type WebsiteOriginRequestEvent,
  type WebsiteViewStateEvent,
  websiteBoundsForFrame,
} from "../engine/sceneWebsiteNative";
import {
  sceneWebsiteKey,
  sceneWebsiteSession,
  useSceneWebsiteSessionStore,
  WEBSITE_ACTIVATE_REQUEST_EVENT,
  WEBSITE_DEACTIVATE_REQUEST_EVENT,
} from "../engine/sceneWebsiteSession";
import { useEditorStore } from "../store/editorStore";
import { useGizmoDocWrite } from "./gizmo/gizmoDocWrite";

const OPEN_ICON = (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M2.5 8h11M8 2c2 2.1 2 9.9 0 12M8 2C6 4.1 6 11.9 8 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

const POSTER_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <rect
      x="2.25"
      y="3"
      width="11.5"
      height="10"
      rx="1.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="m4.5 10 2.3-2.2 1.7 1.5 1.5-1.2 2 1.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
  </svg>
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rectStyle(rect: { x: number; y: number; width: number; height: number }, aspect: number) {
  return {
    left: `${(0.5 + (rect.x - rect.width / 2) / aspect) * 100}%`,
    top: `${(0.5 - (rect.y + rect.height / 2)) * 100}%`,
    width: `${(rect.width / aspect) * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

export function SceneWebsiteOverlay({
  project,
  sceneIndex,
  aspect,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  aspect: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const doc = project.sceneDocs[sceneIndex] ?? null;
  const website = useMemo(() => resolveSceneWebsite(doc ?? undefined), [doc]);
  const playing = useEditorStore((state) => state.playing);
  const cameraArmed = useCameraEditStore((state) => state.armedTool !== null);
  const slug = workspaceSlug(project.id);
  const projectPath = workspaceProjectPath(slug);
  const stem = sceneFileStem(project.sceneFiles[sceneIndex] ?? "");
  const key = sceneWebsiteKey(project.id, stem);
  const session = useSceneWebsiteSessionStore((state) => state.sessions[key]);
  const patchSession = useSceneWebsiteSessionStore((state) => state.patch);
  const { commit } = useGizmoDocWrite(project, sceneIndex, onDocChanged);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const wantsLiveRef = useRef(false);

  const layout = useMemo(
    () => (website ? sceneWebsiteLayout(website, { width: aspect, height: 1 }) : null),
    [website, aspect],
  );

  const bounds = useCallback(() => {
    if (!rootRef.current || !layout) return null;
    return websiteBoundsForFrame(rootRef.current.getBoundingClientRect(), layout, aspect);
  }, [layout, aspect]);

  const activate = useCallback(
    async (requestedOrigins?: string[]) => {
      if (!website?.url || !projectPath || !stem) return;
      const nextBounds = bounds();
      if (!nextBounds) return;
      const existing = sceneWebsiteSession(key).viewId;
      if (existing) await hideWebsite(existing).catch(() => {});
      wantsLiveRef.current = true;
      patchSession(key, { state: "loading", active: false, error: null });
      try {
        const response = await openWebsite({
          projectPath,
          sceneStem: stem,
          url: website.url,
          requestedOrigins: requestedOrigins ?? website.requestedOrigins,
          bounds: nextBounds,
          viewportWidth: website.viewport.width,
          viewportHeight: website.viewport.height,
          zoom: website.viewport.zoom,
        });
        patchSession(key, {
          viewId: response.viewId,
          state: response.state,
          currentOrigin: response.origin,
          pendingOrigin:
            response.state === "needsGrant"
              ? { origin: response.origin, loopback: response.loopback, initial: true }
              : null,
        });
        if (response.state === "ready") {
          await showWebsite(response.viewId);
          patchSession(key, { active: true });
        }
      } catch (error) {
        wantsLiveRef.current = false;
        patchSession(key, { state: "failed", active: false, error: errorMessage(error) });
      }
    },
    [website, projectPath, stem, bounds, patchSession, key],
  );

  const deactivate = useCallback(async () => {
    wantsLiveRef.current = false;
    const current = sceneWebsiteSession(key);
    patchSession(key, { active: false, focused: false });
    if (!current.viewId) return;
    await hideWebsite(current.viewId).catch(() => {});
    await performWebsiteAction(current.viewId, "releaseFocus").catch(() => {});
  }, [key, patchSession]);

  useEffect(() => {
    const activateFromInspector = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key === key) void activate();
    };
    const deactivateFromInspector = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key === key) void deactivate();
    };
    window.addEventListener(WEBSITE_ACTIVATE_REQUEST_EVENT, activateFromInspector);
    window.addEventListener(WEBSITE_DEACTIVATE_REQUEST_EVENT, deactivateFromInspector);
    return () => {
      window.removeEventListener(WEBSITE_ACTIVATE_REQUEST_EVENT, activateFromInspector);
      window.removeEventListener(WEBSITE_DEACTIVATE_REQUEST_EVENT, deactivateFromInspector);
    };
  }, [key, activate, deactivate]);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    let mounted = true;
    const keep = (unlisten: () => void) => {
      if (mounted) unlisteners.push(unlisten);
      else unlisten();
    };
    void listen<WebsiteViewStateEvent>(WEBSITE_STATE_EVENT, (event) => {
      const current = sceneWebsiteSession(key);
      if (event.payload.viewId !== current.viewId) return;
      patchSession(key, {
        state: event.payload.state,
        currentOrigin: event.payload.origin,
        error:
          event.payload.state === "failed" || event.payload.state === "unavailable"
            ? "The website could not be loaded."
            : null,
      });
      if (event.payload.state === "ready" && wantsLiveRef.current) {
        void showWebsite(event.payload.viewId)
          .then(() => patchSession(key, { active: true }))
          .catch((error) =>
            patchSession(key, { state: "failed", active: false, error: errorMessage(error) }),
          );
      } else if (
        event.payload.state === "blocked" ||
        event.payload.state === "failed" ||
        event.payload.state === "unavailable"
      ) {
        void hideWebsite(event.payload.viewId).catch(() => {});
        patchSession(key, { active: false, focused: false });
      }
    }).then(keep);
    void listen<WebsiteOriginRequestEvent>(WEBSITE_ORIGIN_REQUEST_EVENT, (event) => {
      const current = sceneWebsiteSession(key);
      if (event.payload.viewId !== current.viewId) return;
      void hideWebsite(event.payload.viewId).catch(() => {});
      patchSession(key, {
        active: false,
        focused: false,
        pendingOrigin: {
          origin: event.payload.origin,
          loopback: event.payload.loopback,
          initial: false,
        },
      });
    }).then(keep);
    void listen<WebsiteFocusEvent>(WEBSITE_FOCUS_EVENT, (event) => {
      const current = sceneWebsiteSession(key);
      if (event.payload.viewId === current.viewId) {
        patchSession(key, { focused: event.payload.focused });
      }
    }).then(keep);
    return () => {
      mounted = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [key, patchSession]);

  useEffect(() => {
    const root = rootRef.current;
    const current = session;
    if (!root || !layout || !current?.viewId || !wantsLiveRef.current) return;
    const update = () => {
      const nextBounds = bounds();
      if (nextBounds) void setWebsiteBounds(current.viewId as string, nextBounds).catch(() => {});
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [session, layout, bounds]);

  const lastFingerprintRef = useRef(website?.fingerprint ?? null);
  useEffect(() => {
    const previous = lastFingerprintRef.current;
    lastFingerprintRef.current = website?.fingerprint ?? null;
    if (previous !== null && previous !== website?.fingerprint && session?.active) void activate();
  }, [website?.fingerprint, session?.active, activate]);

  useEffect(() => {
    if (playing || cameraArmed) void deactivate();
  }, [playing, cameraArmed, deactivate]);

  useEffect(
    () => () => {
      wantsLiveRef.current = false;
      const current = sceneWebsiteSession(key);
      if (current.viewId) void hideWebsite(current.viewId).catch(() => {});
      patchSession(key, { active: false, focused: false, pendingOrigin: null });
    },
    [key, patchSession],
  );

  useEffect(() => {
    if (!session?.focused) return;
    const release = (event: PointerEvent) => {
      event.stopPropagation();
      event.preventDefault();
      const current = sceneWebsiteSession(key);
      if (current.viewId) void performWebsiteAction(current.viewId, "releaseFocus").catch(() => {});
      patchSession(key, { focused: false });
    };
    document.addEventListener("pointerdown", release, true);
    return () => document.removeEventListener("pointerdown", release, true);
  }, [session?.focused, key, patchSession]);

  const approveOrigin = useCallback(async () => {
    const current = sceneWebsiteSession(key);
    const pending = current.pendingOrigin;
    if (!pending || !projectPath || !website) return;
    const requestedOrigins = [...website.requestedOrigins];
    if (!requestedOrigins.includes(pending.origin)) requestedOrigins.push(pending.origin);
    patchSession(key, { state: "loading", pendingOrigin: null, error: null });
    try {
      await grantWebsiteOrigin(projectPath, pending.origin);
      await commit(
        doc,
        (next) => {
          next.website = { ...(next.website ?? {}), requestedOrigins };
        },
        "allow Website origin",
      );
      if (pending.initial || !current.viewId) {
        await activate(requestedOrigins);
      } else {
        wantsLiveRef.current = true;
        await resumeWebsiteNavigation(current.viewId, requestedOrigins);
      }
    } catch (error) {
      wantsLiveRef.current = false;
      patchSession(key, { state: "failed", active: false, error: errorMessage(error) });
    }
  }, [key, projectPath, website, patchSession, commit, doc, activate]);

  const rejectOrigin = useCallback(() => {
    const current = sceneWebsiteSession(key);
    const initial = current.pendingOrigin?.initial ?? true;
    patchSession(key, { pendingOrigin: null, active: false });
    if (!initial) void activate();
  }, [key, patchSession, activate]);

  if (!website || !layout || playing || cameraArmed) return null;
  const current = session ?? sceneWebsiteSession(key);
  const pageStyle = rectStyle(layout.page, aspect);
  const controlWidth = `${((layout.toolbarHeight * 0.72) / aspect) * 100}%`;
  const controlHeight = `${layout.toolbarHeight * 0.72 * 100}%`;
  const controlLeft = (index: number) =>
    `${(0.5 + (layout.controls.x + index * layout.controls.gap) / aspect) * 100}%`;
  const controlTop = `${(0.5 - layout.controls.y) * 100}%`;

  return (
    <div ref={rootRef} className="scene-website-overlay">
      {!current.active && !current.pendingOrigin && (
        <button
          type="button"
          className={`scene-website-activate${website.capture?.src ? " quiet" : ""}`}
          style={pageStyle}
          disabled={!website.url || current.state === "loading"}
          onClick={() => void activate()}
        >
          {OPEN_ICON}
          {!website.url
            ? "Set a Website URL"
            : current.state === "loading"
              ? "Loading website"
              : current.error
                ? "Website unavailable, try again"
                : "Open live website"}
        </button>
      )}
      {current.viewId && (
        <div className="scene-website-toolbar-targets">
          {(["back", "forward", "reload"] as const).map((action, index) => (
            <button
              key={action}
              type="button"
              className="scene-website-nav-target"
              style={{
                left: controlLeft(index),
                top: controlTop,
                width: controlWidth,
                height: controlHeight,
              }}
              aria-label={action === "reload" ? "Reload website" : `Go ${action}`}
              onClick={() => void performWebsiteAction(current.viewId as string, action)}
            />
          ))}
          {current.active && (
            <button
              type="button"
              className="scene-website-poster-button"
              style={{
                left: `${(0.5 + (layout.window.x + layout.window.width / 2) / aspect) * 100}%`,
                top: controlTop,
              }}
              onClick={() => void deactivate()}
            >
              {POSTER_ICON}
              Poster
            </button>
          )}
        </div>
      )}
      {current.pendingOrigin && (
        <div className="scene-website-consent" role="dialog" aria-modal="true">
          <div className="scene-website-consent-icon">{OPEN_ICON}</div>
          <div>
            <strong>Allow this website?</strong>
            <code>{current.pendingOrigin.origin}</code>
            <p>
              {current.pendingOrigin.loopback
                ? "This local address can change owners. Access lasts only until Kookaburra Cut quits."
                : "This lets the page make browser requests and use the shared Website login profile."}
            </p>
          </div>
          <div className="scene-website-consent-actions">
            <button type="button" className="secondary" onClick={rejectOrigin}>
              Not now
            </button>
            <button type="button" onClick={() => void approveOrigin()}>
              {OPEN_ICON}
              Allow origin
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
