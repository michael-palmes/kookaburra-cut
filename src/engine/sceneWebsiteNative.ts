import { invoke } from "@tauri-apps/api/core";
import type { SceneWebsiteFrameLayout } from "./sceneWebsite";

export type WebsiteViewStateName =
  | "needsGrant"
  | "blocked"
  | "loading"
  | "ready"
  | "unavailable"
  | "failed";

export interface WebsiteBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebsiteOpenRequest {
  projectPath: string;
  sceneStem: string;
  url: string;
  requestedOrigins: string[];
  bounds: WebsiteBounds;
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
}

export interface WebsiteOpenResponse {
  viewId: string;
  state: WebsiteViewStateName;
  origin: string;
  loopback: boolean;
}

export interface WebsiteCaptureResponse {
  src: string;
  width: number;
  height: number;
  sourceOrigin: string | null;
  contentHash: string;
}

export interface WebsiteDataRecord {
  displayName: string;
  dataTypes: string[];
}

export interface WebsiteOriginRequestEvent {
  viewId: string;
  origin: string;
  loopback: boolean;
}

export interface WebsiteViewStateEvent {
  viewId: string;
  state: WebsiteViewStateName;
  origin: string | null;
}

export interface WebsiteFocusEvent {
  viewId: string;
  focused: boolean;
}

export type WebsiteAction =
  | "back"
  | "forward"
  | "reload"
  | "returnToStart"
  | "focus"
  | "releaseFocus";

export const WEBSITE_ORIGIN_REQUEST_EVENT = "kookaburra://website-origin-request";
export const WEBSITE_STATE_EVENT = "kookaburra://website-state";
export const WEBSITE_FOCUS_EVENT = "kookaburra://website-focus";

export function websiteBoundsForFrame(
  frameRect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  layout: SceneWebsiteFrameLayout,
  aspect: number,
): WebsiteBounds {
  const pageLeft = layout.page.x - layout.page.width / 2;
  const pageTop = layout.page.y + layout.page.height / 2;
  return {
    x: frameRect.left + (0.5 + pageLeft / aspect) * frameRect.width,
    y: frameRect.top + (0.5 - pageTop) * frameRect.height,
    width: (layout.page.width / aspect) * frameRect.width,
    height: layout.page.height * frameRect.height,
  };
}

export function openWebsite(request: WebsiteOpenRequest): Promise<WebsiteOpenResponse> {
  return invoke<WebsiteOpenResponse>("website_open", { request });
}

export function showWebsite(viewId: string): Promise<void> {
  return invoke<void>("website_show", { viewId });
}

export function hideWebsite(viewId: string): Promise<void> {
  return invoke<void>("website_hide", { viewId });
}

export function closeWebsite(viewId: string): Promise<void> {
  return invoke<void>("website_close", { viewId });
}

export function setWebsiteBounds(viewId: string, bounds: WebsiteBounds): Promise<void> {
  return invoke<void>("website_set_bounds", { viewId, bounds });
}

export function setWebsiteZoom(viewId: string, zoom: number): Promise<void> {
  return invoke<void>("website_set_zoom", { viewId, zoom });
}

export function performWebsiteAction(viewId: string, action: WebsiteAction): Promise<void> {
  return invoke<void>("website_action", { viewId, action });
}

export function captureWebsite(viewId: string): Promise<WebsiteCaptureResponse> {
  return invoke<WebsiteCaptureResponse>("website_capture", { viewId });
}

export function importWebsiteImage(input: {
  projectPath: string;
  sceneStem: string;
  sourcePath: string;
  width: number;
  height: number;
  background: string;
}): Promise<WebsiteCaptureResponse> {
  return invoke<WebsiteCaptureResponse>("website_import_image", { request: input });
}

export function grantWebsiteOrigin(projectPath: string, origin: string): Promise<void> {
  return invoke<void>("website_grant_origin", { projectPath, origin });
}

export function revokeWebsiteOrigin(projectPath: string, origin: string): Promise<void> {
  return invoke<void>("website_revoke_origin", { projectPath, origin });
}

export function listWebsiteGrants(projectPath: string): Promise<string[]> {
  return invoke<string[]>("website_list_grants", { projectPath });
}

export function listWebsiteData(): Promise<WebsiteDataRecord[]> {
  return invoke<WebsiteDataRecord[]>("website_list_data");
}

export function clearWebsiteData(displayName?: string): Promise<void> {
  return invoke<void>("website_clear_data", { displayName: displayName ?? null });
}

export function resumeWebsiteNavigation(viewId: string, requestedOrigins: string[]): Promise<void> {
  return invoke<void>("website_resume_pending", { viewId, requestedOrigins });
}
