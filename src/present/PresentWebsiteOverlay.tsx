import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LoadedProject, projectFolderPath, sceneFileStem } from "../engine/project";
import { resolveSceneWebsite, sceneWebsiteLayout } from "../engine/sceneWebsite";
import {
  hideWebsite,
  openWebsite,
  performWebsiteAction,
  setWebsiteBounds,
  showWebsite,
  WEBSITE_FOCUS_EVENT,
  WEBSITE_STATE_EVENT,
  type WebsiteFocusEvent,
  type WebsiteViewStateEvent,
  websiteBoundsForFrame,
} from "../engine/sceneWebsiteNative";
import { usePresentStore } from "./presentStore";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PresentWebsiteOverlay({
  project,
  aspect,
}: {
  project: LoadedProject;
  aspect: number;
}) {
  const deck = usePresentStore((state) => state.deck);
  const setWebsiteFocused = usePresentStore((state) => state.setWebsiteFocused);
  const sceneIndex = deck.sceneIndex;
  const doc = project.sceneDocs[sceneIndex] ?? null;
  const website = useMemo(() => resolveSceneWebsite(doc ?? undefined), [doc]);
  const stem = sceneFileStem(project.sceneFiles[sceneIndex] ?? "");
  const projectPath = projectFolderPath(project.id);
  const layout = useMemo(
    () => (website ? sceneWebsiteLayout(website, { width: aspect, height: 1 }) : null),
    [website, aspect],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewIdRef = useRef<string | null>(null);
  const wantsLiveRef = useRef(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [state, setState] = useState<
    "idle" | "loading" | "ready" | "blocked" | "unavailable" | "failed"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const holding = deck.phase === "holding";

  const bounds = useCallback(() => {
    if (!rootRef.current || !layout) return null;
    return websiteBoundsForFrame(rootRef.current.getBoundingClientRect(), layout, aspect);
  }, [layout, aspect]);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    let mounted = true;
    const keep = (unlisten: () => void) => {
      if (mounted) unlisteners.push(unlisten);
      else unlisten();
    };
    void listen<WebsiteViewStateEvent>(WEBSITE_STATE_EVENT, (event) => {
      if (event.payload.viewId !== viewIdRef.current) return;
      if (event.payload.state === "ready" && wantsLiveRef.current) {
        setState("ready");
        void showWebsite(event.payload.viewId).catch((nextError) => {
          setState("failed");
          setError(errorMessage(nextError));
        });
      } else if (
        event.payload.state === "blocked" ||
        event.payload.state === "failed" ||
        event.payload.state === "unavailable"
      ) {
        setState(event.payload.state);
        setWebsiteFocused(false);
        void hideWebsite(event.payload.viewId).catch(() => {});
      } else if (event.payload.state === "loading") {
        setState("loading");
      }
    }).then(keep);
    void listen<WebsiteFocusEvent>(WEBSITE_FOCUS_EVENT, (event) => {
      if (event.payload.viewId === viewIdRef.current) {
        setWebsiteFocused(event.payload.focused);
      }
    }).then(keep);
    return () => {
      mounted = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [setWebsiteFocused]);

  useEffect(() => {
    if (!holding || !website?.url || !projectPath || !stem || !layout) return;
    const nextBounds = bounds();
    if (!nextBounds) return;
    const previous = viewIdRef.current;
    viewIdRef.current = null;
    setViewId(null);
    if (previous) void hideWebsite(previous).catch(() => {});
    let cancelled = false;
    wantsLiveRef.current = true;
    setState("loading");
    setError(null);
    void openWebsite({
      projectPath,
      sceneStem: stem,
      url: website.url,
      requestedOrigins: website.requestedOrigins,
      bounds: nextBounds,
      viewportWidth: website.viewport.width,
      viewportHeight: website.viewport.height,
      zoom: website.viewport.zoom,
    })
      .then(async (response) => {
        if (cancelled) {
          await hideWebsite(response.viewId).catch(() => {});
          return;
        }
        viewIdRef.current = response.viewId;
        setViewId(response.viewId);
        setState(response.state === "needsGrant" ? "blocked" : response.state);
        if (response.state === "ready") await showWebsite(response.viewId);
      })
      .catch((nextError) => {
        if (!cancelled) {
          setState("failed");
          setError(errorMessage(nextError));
        }
      });
    return () => {
      cancelled = true;
      wantsLiveRef.current = false;
      setWebsiteFocused(false);
      const current = viewIdRef.current;
      viewIdRef.current = null;
      if (current) void hideWebsite(current).catch(() => {});
    };
  }, [holding, website, projectPath, stem, layout, bounds, setWebsiteFocused]);

  useEffect(() => {
    if (!viewId || !holding || !layout) return;
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const nextBounds = bounds();
      if (nextBounds) void setWebsiteBounds(viewId, nextBounds).catch(() => {});
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [viewId, holding, layout, bounds]);

  const focused = usePresentStore((present) => present.websiteFocused);
  useEffect(() => {
    if (!focused) return;
    const release = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      const current = viewIdRef.current;
      if (current) void performWebsiteAction(current, "releaseFocus").catch(() => {});
      setWebsiteFocused(false);
    };
    document.addEventListener("click", release, true);
    return () => document.removeEventListener("click", release, true);
  }, [focused, setWebsiteFocused]);

  if (!website || !layout || !holding) return null;
  const controlWidth = `${((layout.toolbarHeight * 0.72) / aspect) * 100}%`;
  const controlHeight = `${layout.toolbarHeight * 0.72 * 100}%`;
  const controlLeft = (index: number) =>
    `${(0.5 + (layout.controls.x + index * layout.controls.gap) / aspect) * 100}%`;
  const controlTop = `${(0.5 - layout.controls.y) * 100}%`;
  return (
    <div ref={rootRef} className="scene-website-overlay">
      {viewId && state === "ready" && (
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
              onClick={(event) => {
                event.stopPropagation();
                void performWebsiteAction(viewId, action);
              }}
            />
          ))}
        </div>
      )}
      {(state === "blocked" || state === "failed" || state === "unavailable") && (
        <div className="scene-website-present-status">
          {state === "blocked" ? "Live website not approved" : "Live website unavailable"}
          {error && <span>{error}</span>}
        </div>
      )}
    </div>
  );
}
