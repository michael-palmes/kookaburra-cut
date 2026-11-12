import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

async function sheet(singleKey: boolean): Promise<string> {
  vi.resetModules();
  const prefs = await import("./chromePrefs");
  prefs.setSingleKeyShortcuts(singleKey);
  const { ShortcutsSheet } = await import("./ShortcutsSheet");
  return renderToStaticMarkup(<ShortcutsSheet onClose={() => {}} />);
}

afterEach(() => vi.unstubAllGlobals());

describe("shortcuts sheet and the single-key switch (2.1.4)", () => {
  it("knows which rows are bare letters", async () => {
    const { isSingleKeyRow } = await import("./ShortcutsSheet");
    expect(isSingleKeyRow("S")).toBe(true);
    expect(isSingleKeyRow("O / P / Z")).toBe(true);
    expect(isSingleKeyRow("⌘K")).toBe(false);
    expect(isSingleKeyRow("Space")).toBe(false);
    expect(isSingleKeyRow("⇧F10")).toBe(false);
  });

  it("points to the switch while letter keys are on", async () => {
    const html = await sheet(true);
    expect(html).toContain("Turn them off in Settings › Accessibility");
    expect(html).not.toContain("(off)");
  });

  it("says so, and marks each letter row, once they are off", async () => {
    const html = await sheet(false);
    expect(html).toContain("Single-key shortcuts are off");
    expect(html).toContain("Split the clip under the playhead (off)");
    expect(html).toContain("arm Orbit / Pan / Zoom (animation mode open) (off)");
    expect(html).not.toContain("Find an action (command palette) (off)");
  });
});
