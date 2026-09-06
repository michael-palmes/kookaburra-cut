import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_THEME_CATALOGUE } from "../../theme/catalogue";
import { updateBuiltinTheme } from "../../theme/registry";
import { onThemeSaved, readThemeSourceDoc, type ThemeSavedPayload } from "./themeEditorIo";

const events = vi.hoisted(() => ({
  receive: null as ((event: { payload: ThemeSavedPayload }) => void) | null,
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async (_name, receive) => {
    events.receive = receive;
    return events.stop;
  }),
}));
const original = BUILTIN_THEME_CATALOGUE[0];
const originalDoc = original.doc as Record<string, unknown>;
afterEach(() => updateBuiltinTheme(original.id, original.doc));

describe("theme save notifications", () => {
  it("refreshes bundled source documents before notifying galleries without HMR", async () => {
    const changed = vi.fn();
    const stop = onThemeSaved(changed);
    const payload = {
      themeId: original.id,
      json: JSON.stringify({ ...originalDoc, name: "Updated in the theme editor" }),
    };
    events.receive?.({ payload });
    expect((await readThemeSourceDoc(original.id)).name).toBe("Updated in the theme editor");
    expect(changed).toHaveBeenCalledWith(payload);
    stop();
  });

  it("ignores queued notifications after the subscriber is disposed", async () => {
    const changed = vi.fn();
    const stop = onThemeSaved(changed);
    stop();
    events.receive?.({ payload: { themeId: original.id, json: "invalid late event" } });
    expect(changed).not.toHaveBeenCalled();
    expect((await readThemeSourceDoc(original.id)).name).toBe(originalDoc.name);
  });
});
