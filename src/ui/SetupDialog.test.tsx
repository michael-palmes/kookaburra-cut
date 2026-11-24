import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SetupDialog } from "./SetupDialog";

const escapeLayer = vi.hoisted(() => ({ close: null as null | (() => void) }));
vi.mock("./useEscapeClose", () => ({
  useEscapeClose: (onClose: () => void) => {
    escapeLayer.close = onClose;
  },
}));

describe("SetupDialog", () => {
  it("offers the Claude choice with nothing selected and holds Get started until one is", () => {
    const html = renderToStaticMarkup(
      <SetupDialog onAnswer={() => undefined} askClaude askUpdates />,
    );
    expect(html).toContain("With Claude");
    expect(html).toContain("Your project goes to Anthropic.");
    expect(html).toContain("On this Mac only");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toMatch(/type="radio"[^>]*checked/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Get started/);
    expect(html).toContain("What leaves your Mac");
  });

  it("starts the update switch on and names where the check goes", () => {
    const html = renderToStaticMarkup(
      <SetupDialog onAnswer={() => undefined} askClaude askUpdates />,
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Anonymous, with GitHub.");
    const own = renderToStaticMarkup(
      <SetupDialog onAnswer={() => undefined} askClaude askUpdates organisationServer />,
    );
    expect(own).toContain("your organisation&#x27;s server");
    expect(own).not.toContain("GitHub");
  });

  it("saves off for everything it asked when Escape dismisses a first launch", () => {
    const onAnswer = vi.fn();
    renderToStaticMarkup(<SetupDialog onAnswer={onAnswer} askClaude askUpdates />);
    escapeLayer.close?.();
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ claude: false, updates: false });
  });

  it("stores nothing for a part it did not ask or could not offer", () => {
    const onAnswer = vi.fn();
    renderToStaticMarkup(<SetupDialog onAnswer={onAnswer} askClaude askUpdates={false} />);
    escapeLayer.close?.();
    expect(onAnswer).toHaveBeenLastCalledWith({ claude: false, updates: null });

    renderToStaticMarkup(
      <SetupDialog
        onAnswer={onAnswer}
        askClaude
        askUpdates
        claudeLock="managed"
        updatesLock="installer"
      />,
    );
    escapeLayer.close?.();
    expect(onAnswer).toHaveBeenLastCalledWith({ claude: null, updates: null });
  });

  it("shows a lock in place of the Claude choice a profile owns, and lets the person in", () => {
    const off = renderToStaticMarkup(
      <SetupDialog onAnswer={() => undefined} askClaude askUpdates claudeLock="managed" />,
    );
    expect(off).toContain("Turned off by your organisation.");
    expect(off).not.toContain('type="radio"');
    expect(off).not.toMatch(/<button[^>]*disabled=""[^>]*>Get started/);

    const missing = renderToStaticMarkup(
      <SetupDialog onAnswer={() => undefined} askClaude askUpdates claudeLock="orgMissing" />,
    );
    expect(missing).toContain("Needs your organisation&#x27;s Claude settings. Ask IT.");
    expect(missing).not.toContain('type="radio"');
  });

  it("says when the organisation's Claude settings cover this Mac", () => {
    const html = renderToStaticMarkup(
      <SetupDialog onAnswer={() => undefined} askClaude askUpdates claudeCovered />,
    );
    expect(html).toContain("Covered by your organisation&#x27;s Claude settings.");
  });

  it("leaves the update switch out where the installer or a profile owns updates", () => {
    const installer = renderToStaticMarkup(
      <SetupDialog onAnswer={() => undefined} askClaude askUpdates updatesLock="installer" />,
    );
    expect(installer).toContain("Delivered by the installer package.");
    expect(installer).not.toContain('role="switch"');
    const profile = renderToStaticMarkup(
      <SetupDialog onAnswer={() => undefined} askClaude askUpdates updatesLock="managed" />,
    );
    expect(profile).toContain("Turned off by your organisation.");
    expect(profile).not.toContain('role="switch"');
  });

  it("reopened from the titlebar, Escape changes nothing", () => {
    const onAnswer = vi.fn();
    const onCancel = vi.fn();
    const html = renderToStaticMarkup(
      <SetupDialog onAnswer={onAnswer} onCancel={onCancel} askClaude askUpdates={false} />,
    );
    expect(html).toContain("Set up Claude");
    expect(html).toContain("Cancel");
    expect(html).not.toContain('role="switch"');
    escapeLayer.close?.();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
