import { describe, expect, it, vi } from "vitest";
import { parseSceneDoc } from "./sceneDocSchema";
import {
  normaliseWebsiteUrl,
  parseSceneWebsite,
  resolveSceneWebsite,
  type SceneDocWebsite,
  sceneWebsiteLayout,
  WEBSITE_DEFAULTS,
  websiteCaptureFingerprint,
} from "./sceneWebsite";

const FRAME = { width: 12, height: 6.75 };

describe("normaliseWebsiteUrl", () => {
  it("accepts public HTTPS and preserves the authored route", () => {
    expect(normaliseWebsiteUrl("https://example.com/product?q=demo#overview")).toEqual({
      url: "https://example.com/product?q=demo#overview",
      origin: "https://example.com",
      loopback: false,
    });
  });

  it("accepts explicit-port loopback and rejects unsafe navigation", () => {
    expect(normaliseWebsiteUrl("http://localhost:5173/demo")).toMatchObject({
      origin: "http://localhost:5173",
      loopback: true,
    });
    expect(normaliseWebsiteUrl("https://[::1]:8443/demo")).toMatchObject({
      origin: "https://[::1]:8443",
      loopback: true,
    });
    for (const value of [
      "http://example.com",
      "http://localhost/demo",
      "https://localhost/demo",
      "https://user:secret@example.com",
      "file:///tmp/demo.html",
      "data:text/html,hello",
      "javascript:alert(1)",
    ]) {
      expect(normaliseWebsiteUrl(value), value).toBeNull();
    }
  });
});

describe("parseSceneWebsite", () => {
  it("passes a well-formed block through and normalises requested origins", () => {
    const block: SceneDocWebsite = {
      url: "https://example.com/product?mode=demo#overview",
      requestedOrigins: ["https://example.com/elsewhere", "https://auth.example.com/login"],
      viewport: { preset: "desktop", orientation: "landscape", zoom: 1 },
      frame: { appearance: "match-theme", cornerRadius: 14, shadow: "soft" },
      position: [0.1, -0.2],
      size: 0.72,
      capture: {
        src: "assets/website/01-intro.png",
        width: 1440,
        height: 900,
        source: "snapshot",
        sourceOrigin: "https://example.com/path",
        fingerprint: "v1:capture",
      },
    };
    expect(parseSceneWebsite(block, "test")).toEqual({
      ...block,
      requestedOrigins: ["https://example.com", "https://auth.example.com"],
      capture: { ...block.capture, sourceOrigin: "https://example.com" },
    });
  });

  it("drops unsafe and malformed fields independently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      parseSceneWebsite(
        {
          url: "javascript:alert(1)",
          requestedOrigins: ["https://good.example/path", "http://evil.example", 4],
          viewport: { preset: "tv", orientation: "sideways", width: 900, height: "wide" },
          frame: { appearance: "sepia", cornerRadius: 8, shadow: "huge" },
          position: [0.1],
          size: 0.6,
          capture: {
            src: "../secret.png",
            width: 900,
            source: "camera",
            sourceOrigin: "file:///tmp",
            fingerprint: "old",
          },
        },
        "test",
      ),
    ).toEqual({
      requestedOrigins: ["https://good.example"],
      viewport: { width: 900 },
      frame: { cornerRadius: 8 },
      size: 0.6,
      capture: { width: 900 },
    });
    warn.mockRestore();
  });

  it("drops a non-object block and rides the scene document parser", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSceneWebsite("website", "test")).toBeUndefined();
    const parsed = parseSceneDoc(
      { version: 1, name: "Website demo", website: { url: "https://example.com/demo" } },
      "test",
    );
    expect(parsed?.website).toEqual({ url: "https://example.com/demo" });
    expect(parseSceneDoc({ version: 1, website: 7 }, "test")?.website).toBeUndefined();
    warn.mockRestore();
  });
});

describe("resolveSceneWebsite", () => {
  it("is null without a block and fully defaults an empty block", () => {
    expect(resolveSceneWebsite(undefined)).toBeNull();
    expect(resolveSceneWebsite({})).toBeNull();
    const resolved = resolveSceneWebsite({ website: {} });
    expect(resolved).toMatchObject({
      url: null,
      origin: null,
      loopback: false,
      requestedOrigins: [],
      viewport: {
        preset: "desktop",
        orientation: "landscape",
        width: 1440,
        height: 900,
        zoom: 1,
      },
      frame: {
        appearance: "match-theme",
        cornerRadius: 14,
        shadow: "soft",
      },
      position: [0, 0],
      size: WEBSITE_DEFAULTS.size,
      capture: null,
      captureStale: false,
    });
  });

  it("orients presets and clamps custom dimensions and display values", () => {
    expect(
      resolveSceneWebsite({
        website: {
          viewport: { preset: "mobile", orientation: "landscape", zoom: 9 },
          frame: { cornerRadius: 99 },
          position: [-4, 4],
          size: 9,
        },
      }),
    ).toMatchObject({
      viewport: { width: 844, height: 390, zoom: 2 },
      frame: { cornerRadius: 32 },
      position: [-1.5, 1.5],
      size: 1.5,
    });
    expect(
      resolveSceneWebsite({
        website: {
          viewport: { preset: "custom", width: 9999, height: 2, orientation: "portrait" },
        },
      })?.viewport,
    ).toMatchObject({ width: 320, height: 2160, orientation: "portrait" });
  });

  it("adds the authored origin to requested origins without treating it as a grant", () => {
    expect(
      resolveSceneWebsite({
        website: {
          url: "https://example.com/demo",
          requestedOrigins: ["https://auth.example.com"],
        },
      })?.requestedOrigins,
    ).toEqual(["https://auth.example.com", "https://example.com"]);
  });
});

describe("website capture freshness", () => {
  it("covers URL, viewport, zoom and frame, but not placement", () => {
    const initial = resolveSceneWebsite({ website: { url: "https://example.com" } });
    if (!initial) throw new Error("unresolved");
    expect(websiteCaptureFingerprint(initial)).toBe(initial.fingerprint);
    const moved = resolveSceneWebsite({
      website: { url: "https://example.com", position: [0.5, -0.4], size: 0.4 },
    });
    expect(moved?.fingerprint).toBe(initial.fingerprint);
    const changed = resolveSceneWebsite({
      website: { url: "https://example.com", viewport: { zoom: 1.25 } },
    });
    expect(changed?.fingerprint).not.toBe(initial.fingerprint);
  });

  it("keeps an old capture as truth and marks it stale", () => {
    const base = resolveSceneWebsite({ website: { url: "https://example.com" } });
    if (!base) throw new Error("unresolved");
    const fresh = resolveSceneWebsite({
      website: {
        url: "https://example.com",
        capture: { src: "assets/website/demo.png", fingerprint: base.fingerprint },
      },
    });
    expect(fresh?.captureStale).toBe(false);
    const stale = resolveSceneWebsite({
      website: {
        url: "https://example.com/changed",
        capture: { src: "assets/website/demo.png", fingerprint: base.fingerprint },
      },
    });
    expect(stale?.captureStale).toBe(true);
    expect(stale?.capture?.src).toBe("assets/website/demo.png");
  });
});

describe("sceneWebsiteLayout", () => {
  it("uses the configured CSS aspect and keeps chrome outside the page", () => {
    const website = resolveSceneWebsite({ website: { size: 0.5 } });
    if (!website) throw new Error("unresolved");
    const layout = sceneWebsiteLayout(website, FRAME);
    expect(layout.window.width).toBeCloseTo(6);
    expect(layout.page.width).toBeCloseTo(6);
    expect(layout.page.height).toBeCloseTo(6 * (900 / 1440));
    expect(layout.toolbarHeight).toBeCloseTo(6 * (52 / 1440));
    expect(layout.window.height).toBeCloseTo(layout.page.height + layout.toolbarHeight);
    expect(layout.page.y + layout.page.height / 2).toBeCloseTo(
      layout.toolbar.y - layout.toolbar.height / 2,
    );
  });

  it("moves and scales the display without changing capture geometry", () => {
    const website = resolveSceneWebsite({
      website: { position: [0.5, -0.5], size: 0.4, viewport: { preset: "tablet" } },
    });
    if (!website) throw new Error("unresolved");
    const layout = sceneWebsiteLayout(website, FRAME);
    expect(layout.window.x).toBeCloseTo(3);
    expect(layout.window.y).toBeCloseTo(-1.6875);
    expect(layout.window.width).toBeCloseTo(4.8);
    expect(layout.page.height / layout.page.width).toBeCloseTo(768 / 1024);
  });
});
