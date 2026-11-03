import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingWebsiteOrigin } from "../engine/sceneWebsiteSession";
import { pendingFromRequest, settleWebsiteGrant, WebsiteBlockedCard } from "./SceneWebsiteOverlay";

const origin = "https://example.com";
const initial: PendingWebsiteOrigin = { origin, loopback: false, initial: true };
const navigated: PendingWebsiteOrigin = { origin, loopback: false, initial: false };

function steps(hasView = true) {
  return {
    decline: vi.fn(),
    commit: vi.fn(async () => {}),
    reopen: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    hasView,
  };
}

describe("website blocked card", () => {
  it("shows the origin and one Allow button with a leading icon, no in-page answer", () => {
    const html = renderToStaticMarkup(<WebsiteBlockedCard origin={origin} onAllow={() => {}} />);
    expect(html).toContain(origin);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*><svg[\s\S]*<\/svg>Allow this website…<\/button>/);
    expect(html).not.toContain("Not now");
    expect(html).not.toContain('role="dialog"');
  });
});

describe("the sheet's answer", () => {
  it("commits then reopens after allowing the scene's own page", async () => {
    const s = steps();
    await settleWebsiteGrant(initial, true, s);
    expect(s.commit).toHaveBeenCalledOnce();
    expect(s.reopen).toHaveBeenCalledOnce();
    expect(s.resume).not.toHaveBeenCalled();
    expect(s.commit.mock.invocationCallOrder[0]).toBeLessThan(s.reopen.mock.invocationCallOrder[0]);
  });

  it("commits then resumes after allowing a navigation", async () => {
    const s = steps();
    await settleWebsiteGrant(navigated, true, s);
    expect(s.commit).toHaveBeenCalledOnce();
    expect(s.resume).toHaveBeenCalledOnce();
    expect(s.reopen).not.toHaveBeenCalled();
  });

  it("reopens a navigation whose view has gone", async () => {
    const s = steps(false);
    await settleWebsiteGrant(navigated, true, s);
    expect(s.reopen).toHaveBeenCalledOnce();
    expect(s.resume).not.toHaveBeenCalled();
  });

  it("writes nothing and stays blocked when the scene's own page is declined", async () => {
    const s = steps();
    await settleWebsiteGrant(initial, false, s);
    expect(s.decline).toHaveBeenCalledOnce();
    expect(s.commit).not.toHaveBeenCalled();
    expect(s.reopen).not.toHaveBeenCalled();
    expect(s.resume).not.toHaveBeenCalled();
  });

  it("returns to the authored page when a navigation is declined", async () => {
    const s = steps();
    await settleWebsiteGrant(navigated, false, s);
    expect(s.decline).toHaveBeenCalledOnce();
    expect(s.commit).not.toHaveBeenCalled();
    expect(s.reopen).toHaveBeenCalledOnce();
    expect(s.resume).not.toHaveBeenCalled();
  });
});

describe("the origin request event", () => {
  const request = { origin, loopback: false };

  it("reads as a navigation when nothing is waiting", () => {
    expect(pendingFromRequest(null, request).initial).toBe(false);
  });

  it("keeps a waiting page's start when website_open's answer got there first", () => {
    expect(pendingFromRequest(initial, request).initial).toBe(true);
  });

  it("reads as a navigation when another origin was waiting", () => {
    const other = { ...initial, origin: "https://other.example" };
    expect(pendingFromRequest(other, request).initial).toBe(false);
  });
});
