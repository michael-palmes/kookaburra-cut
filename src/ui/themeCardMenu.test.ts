import { describe, expect, it, vi } from "vitest";
import type { ContextMenuItem } from "./ContextMenu";
import type { ThemeChoice } from "./ThemePicker";
import { buildThemeCardMenu } from "./themeCardMenu";

const choice = (id: string): ThemeChoice => ({
  id,
  name: "Example",
  source: id.startsWith("ws:") ? "workspace" : "bundled",
  useLabel: "Example",
  tags: [],
  previews: null,
  background: "black",
  text: "white",
  accent: "blue",
});
const options = () => ({ onManage: vi.fn(), onThemeEdited: vi.fn(), onChanged: vi.fn() });
const actions = (items: (ContextMenuItem | "separator")[]) =>
  items.filter((item): item is ContextMenuItem => item !== "separator");

describe("theme card actions", () => {
  it("offers moving personal themes only in development", () => {
    const onMove = vi.fn();
    const opts = { ...options(), onMove };
    const personal = choice("ws:personal");
    const dev = actions(buildThemeCardMenu(personal, opts, vi.fn(), true));
    dev.find((item) => item.id === "move")?.onSelect();
    expect(onMove).toHaveBeenCalledWith(personal);
    expect(
      actions(buildThemeCardMenu(personal, opts, vi.fn(), false)).some(
        (item) => item.id === "move",
      ),
    ).toBe(false);
    expect(
      actions(buildThemeCardMenu(choice("studio"), opts, vi.fn(), true)).some(
        (item) => item.id === "move",
      ),
    ).toBe(false);
  });
  it("keeps release app themes read-only", () => {
    const items = actions(buildThemeCardMenu(choice("studio"), options(), vi.fn(), false));
    expect(items.map((item) => item.id)).toEqual(["duplicate"]);
  });
  it("provides personal theme management without project-only actions", () => {
    const opts = options();
    const items = actions(buildThemeCardMenu(choice("ws:personal"), opts, vi.fn(), false));
    expect(items.map((item) => item.id)).toEqual([
      "duplicate",
      "edit",
      "fonts",
      "rename",
      "delete",
    ]);
    expect(items.every((item) => item.icon !== undefined)).toBe(true);
    items[0].onSelect();
    expect(opts.onManage).toHaveBeenCalledWith({ view: "duplicate", themeId: "ws:personal" });
  });
  it("uses the host's apply and Claude actions and permits bundled edits in development", () => {
    const onApply = vi.fn();
    const opts = { ...options(), onApply, onEditInClaude: vi.fn() };
    const mine = actions(buildThemeCardMenu(choice("ws:personal"), opts, vi.fn(), true));
    mine.find((item) => item.id === "apply")?.onSelect();
    expect(onApply).toHaveBeenCalledWith("ws:personal");
    expect(mine.some((item) => item.id === "claude")).toBe(true);
    const bundled = actions(buildThemeCardMenu(choice("studio"), opts, vi.fn(), true));
    expect(bundled.map((item) => item.id)).toEqual([
      "apply",
      "duplicate",
      "edit",
      "delete-builtin",
    ]);
    expect(bundled.find((item) => item.id === "delete-builtin")?.confirmLabel).toBeTruthy();
  });
});
