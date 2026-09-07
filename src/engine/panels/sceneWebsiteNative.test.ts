import { describe, expect, it, vi } from "vitest";
import { resolveSceneWebsite, sceneWebsiteLayout } from "./sceneWebsite";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  clearWebsiteData,
  grantWebsiteOrigin,
  importWebsiteImage,
  listWebsiteData,
  openWebsite,
  performWebsiteAction,
  resumeWebsiteNavigation,
  setWebsiteBounds,
  showWebsite,
  websiteBoundsForFrame,
} from "./sceneWebsiteNative";

describe("websiteBoundsForFrame", () => {
  it("maps the shared page rect into owner-window logical pixels", () => {
    const website = resolveSceneWebsite({ website: { size: 0.5, position: [0.2, -0.1] } });
    if (!website) throw new Error("unresolved");
    const aspect = 16 / 9;
    const layout = sceneWebsiteLayout(website, { width: aspect, height: 1 });
    const bounds = websiteBoundsForFrame(
      { left: 100, top: 50, width: 1600, height: 900 },
      layout,
      aspect,
    );
    expect(bounds.width).toBeCloseTo(800);
    expect(bounds.height).toBeCloseTo(800 * (900 / 1440));
    expect(bounds.x).toBeCloseTo(100 + (0.5 + 0.1 - 0.25) * 1600);
    const pageTop = layout.page.y + layout.page.height / 2;
    expect(bounds.y).toBeCloseTo(50 + (0.5 - pageTop) * 900);
  });
});

describe("Website native command surface", () => {
  it("uses one request object and narrow command arguments", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const request = {
      projectPath: "/projects/demo",
      sceneStem: "01-intro",
      url: "https://example.com",
      requestedOrigins: ["https://example.com"],
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      viewportWidth: 1440,
      viewportHeight: 900,
      zoom: 1,
    };
    await openWebsite(request);
    await showWebsite("view-1");
    await setWebsiteBounds("view-1", request.bounds);
    await performWebsiteAction("view-1", "returnToStart");
    await grantWebsiteOrigin(request.projectPath, request.url);
    await resumeWebsiteNavigation("view-1", request.requestedOrigins);
    const imageRequest = {
      projectPath: request.projectPath,
      sceneStem: request.sceneStem,
      sourcePath: "/tmp/poster.png",
      width: 1440,
      height: 900,
      background: "#ffffff",
    };
    await importWebsiteImage(imageRequest);
    await listWebsiteData();
    await clearWebsiteData("example.com");
    await clearWebsiteData();
    expect(mocks.invoke.mock.calls).toEqual([
      ["website_open", { request }],
      ["website_show", { viewId: "view-1" }],
      ["website_set_bounds", { viewId: "view-1", bounds: request.bounds }],
      ["website_action", { viewId: "view-1", action: "returnToStart" }],
      ["website_grant_origin", { projectPath: request.projectPath, origin: request.url }],
      ["website_resume_pending", { viewId: "view-1", requestedOrigins: request.requestedOrigins }],
      ["website_import_image", { request: imageRequest }],
      ["website_list_data"],
      ["website_clear_data", { displayName: "example.com" }],
      ["website_clear_data", { displayName: null }],
    ]);
  });
});
