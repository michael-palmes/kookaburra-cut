import { describe, expect, it } from "vitest";
import { groupProjectItems, matchesPackSearch } from "./projectGroups";
import { EMPTY_STATE, isIncluded, toggle, toggleAll } from "./selection";
import type { SelectableItem } from "./types";

const project = (slug: string, group?: string, name = slug): SelectableItem => ({
  kind: "project",
  slug,
  name,
  bytes: 100,
  requiredBy: [],
  group,
});

describe("groupProjectItems", () => {
  it("follows the welcome rail: Ungrouped, then groups A to Z, keeping catalogue order inside each", () => {
    const items = [
      project("a", "Alpha"),
      project("b", "Zebra"),
      project("c"),
      project("d", "Alpha"),
    ];
    expect(
      groupProjectItems(items).map((s) => [s.row.label, s.row.iconId, s.items.map((i) => i.slug)]),
    ).toEqual([
      ["Ungrouped", "ungrouped", ["c"]],
      ["Alpha", "group", ["a", "d"]],
      ["Zebra", "group", ["b"]],
    ]);
  });

  it("drops empty groups", () => {
    expect(groupProjectItems([project("a", "Alpha")]).map((s) => s.row.label)).toEqual(["Alpha"]);
    expect(groupProjectItems([])).toEqual([]);
  });
});

describe("matchesPackSearch", () => {
  const item = project("launch-2026", "Client work", "Launch Film");

  it("keeps everything for an empty or blank query", () => {
    expect(matchesPackSearch(item, "")).toBe(true);
    expect(matchesPackSearch(item, "   ")).toBe(true);
  });

  it("matches the name, slug or group, ignoring case", () => {
    expect(matchesPackSearch(item, "FILM")).toBe(true);
    expect(matchesPackSearch(item, "2026")).toBe(true);
    expect(matchesPackSearch(item, "client")).toBe(true);
    expect(matchesPackSearch(project("scratch"), "client")).toBe(false);
  });
});

describe("toggleAll", () => {
  it("ticks and unticks every item in the set", () => {
    const set = [project("a"), project("b")];
    const on = toggleAll(toggle(EMPTY_STATE, set[0], true), set, true);
    expect(set.every((i) => isIncluded(on, i))).toBe(true);
    const off = toggleAll(on, set, false);
    expect(set.some((i) => isIncluded(off, i))).toBe(false);
  });
});
