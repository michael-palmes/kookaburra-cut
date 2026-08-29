import { describe, expect, it } from "vitest";
import type { SceneWebsiteSession } from "./sceneWebsiteSession";
import { websiteSessionClaimsStage } from "./sceneWebsiteSession";

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
