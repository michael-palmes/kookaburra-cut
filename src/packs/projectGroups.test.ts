import { describe, expect, it } from "vitest";
import { groupProjectItems, matchesPackSearch } from "./projectGroups";
import { EMPTY_STATE, isIncluded, toggle, toggleAll } from "./selection";
import type { SelectableItem } from "./types";

const project = (slug: string, name = slug): SelectableItem => ({
  kind: "project",
  slug,
  name,
  bytes: 100,
  requiredBy: [],
});

describe("groupProjectItems", () => {
  it("orders named groups A to Z, then the ungrouped projects, keeping catalogue order inside each", () => {
    const items = [project("a"), project("b"), project("c"), project("d")];
    const groups = new Map([
      ["b", "Zebra"],
      ["d", "Alpha"],
      ["a", "Alpha"],
    ]);
    expect(
      groupProjectItems(items, groups).map((s) => [s.group, s.items.map((i) => i.slug)]),
    ).toEqual([
      ["Alpha", ["a", "d"]],
      ["Zebra", ["b"]],
      [null, ["c"]],
    ]);
  });

  it("returns one ungrouped section when nothing is grouped", () => {
    expect(groupProjectItems([project("a")], new Map())).toEqual([
      { group: null, items: [project("a")] },
    ]);
  });

  it("drops empty sections", () => {
    expect(groupProjectItems([], new Map([["a", "Alpha"]]))).toEqual([]);
  });
});

describe("matchesPackSearch", () => {
  const item = project("launch-2026", "Launch Film");

  it("keeps everything for an empty or blank query", () => {
    expect(matchesPackSearch(item, "")).toBe(true);
    expect(matchesPackSearch(item, "   ")).toBe(true);
  });

  it("matches the name, slug or group, ignoring case", () => {
    expect(matchesPackSearch(item, "FILM")).toBe(true);
    expect(matchesPackSearch(item, "2026")).toBe(true);
    expect(matchesPackSearch(item, "client", "Client work")).toBe(true);
    expect(matchesPackSearch(item, "client")).toBe(false);
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
