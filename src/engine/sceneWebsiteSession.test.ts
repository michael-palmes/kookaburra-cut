import { describe, expect, it } from "vitest";
import type { SceneWebsiteSession } from "./sceneWebsiteSession";
import { websiteSessionCanShow, websiteSessionClaimsStage } from "./sceneWebsiteSession";

function session(patch: Partial<SceneWebsiteSession> = {}): SceneWebsiteSession {
  return {
    viewId: null,
    state: "idle",
    active: false,
    focused: false,
    currentOrigin: null,
    pendingOrigin: null,
    error: null,
    ...patch,
  };
}

describe("websiteSessionClaimsStage", () => {
  it("leaves the Website gizmo available for an inactive poster", () => {
    expect(websiteSessionClaimsStage(undefined)).toBe(false);
    expect(websiteSessionClaimsStage(session())).toBe(false);
  });

  it("gives a live website exclusive stage interaction", () => {
    expect(websiteSessionClaimsStage(session({ active: true }))).toBe(true);
  });

  it("gives an origin consent dialog exclusive stage interaction", () => {
    expect(
      websiteSessionClaimsStage(
        session({
          pendingOrigin: {
            origin: "https://www.apple.com",
            loopback: false,
            initial: true,
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("websiteSessionCanShow", () => {
  const ready = session({ viewId: "website-1", state: "ready" });

  it("allows an explicitly requested ready view", () => {
    expect(websiteSessionCanShow(ready, true, false)).toBe(true);
  });

  it("fails closed while editor chrome obscures the stage", () => {
    expect(websiteSessionCanShow(ready, true, true)).toBe(false);
  });

  it("rejects implicit, pending and incomplete views", () => {
    expect(websiteSessionCanShow(ready, false, false)).toBe(false);
    expect(
      websiteSessionCanShow(session({ viewId: "website-1", state: "loading" }), true, false),
    ).toBe(false);
    expect(
      websiteSessionCanShow(
        session({
          viewId: "website-1",
          state: "ready",
          pendingOrigin: {
            origin: "https://www.apple.com",
            loopback: false,
            initial: false,
          },
        }),
        true,
        false,
      ),
    ).toBe(false);
  });
});
