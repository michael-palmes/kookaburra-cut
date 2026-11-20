import { describe, expect, it } from "vitest";
import type { TemplateEntry } from "../engine/templates";
import {
  availableLooks,
  CLAUDE_START_ID,
  claudeStartMatches,
  DEFAULT_THEME_ID,
  defaultProjectName,
  gridColumnCount,
  initialLookThemeId,
  lookChoices,
  lookSelection,
  selectionAfterFilter,
  startAfterSearch,
  startGridStep,
} from "./newProjectFlow";
import type { ThemeChoice } from "./ThemePicker";

const choice = (
  id: string,
  source: ThemeChoice["source"],
  mode: ThemeChoice["mode"],
): ThemeChoice => ({
  id,
  name: id,
  source,
  useLabel: "",
  tags: [],
  mode,
  previews: null,
  background: "#000000",
  accent: "#000000",
  text: "#000000",
});

describe("defaultProjectName", () => {
  const day = new Date(2026, 9, 22, 9, 30);

  it("dates the name with the local day", () => {
    expect(defaultProjectName(day, [])).toBe("2026-10-22 - New Project");
    expect(defaultProjectName(new Date(2027, 0, 5), [])).toBe("2027-01-05 - New Project");
  });

  it("numbers on past names already taken today", () => {
    expect(defaultProjectName(day, ["2026-10-22-new-project"])).toBe("2026-10-22 - New Project 2");
    expect(defaultProjectName(day, ["2026-10-22-new-project", "2026-10-22-new-project-2"])).toBe(
      "2026-10-22 - New Project 3",
    );
  });
});

describe("claudeStartMatches", () => {
  it("shows with no search and for the words it stands for", () => {
    expect(claudeStartMatches("")).toBe(true);
    expect(claudeStartMatches("Claude")).toBe(true);
    expect(claudeStartMatches("blank")).toBe(true);
  });

  it("hides for an unrelated search", () => {
    expect(claudeStartMatches("changelog")).toBe(false);
  });
});

describe("gridColumnCount", () => {
  it("counts the computed tracks, falling back when there are none", () => {
    expect(gridColumnCount("336px 336px 336px", 3)).toBe(3);
    expect(gridColumnCount("250px 250px 250px 250px", 3)).toBe(4);
    expect(gridColumnCount("none", 3)).toBe(3);
    expect(gridColumnCount("", 3)).toBe(3);
  });
});

describe("startGridStep", () => {
  // With the Claude card: row one is Claude (two cells) + index 1; row two is 2, 3, 4.
  it("moves down and up through the wide lead card", () => {
    expect(startGridStep("ArrowDown", 0, 8, true, 3)).toBe(2);
    expect(startGridStep("ArrowDown", 1, 8, true, 3)).toBe(4);
    expect(startGridStep("ArrowUp", 3, 8, true, 3)).toBe(0);
    expect(startGridStep("ArrowUp", 4, 8, true, 3)).toBe(1);
    expect(startGridStep("ArrowUp", 1, 8, true, 3)).toBe(1);
  });

  it("walks a plain three-column grid", () => {
    expect(startGridStep("ArrowDown", 1, 8, false, 3)).toBe(4);
    expect(startGridStep("ArrowDown", 6, 8, false, 3)).toBe(7);
    expect(startGridStep("End", 3, 8, false, 3)).toBe(5);
    expect(startGridStep("Home", 5, 8, false, 3)).toBe(3);
  });

  it("follows the column count it is given", () => {
    // Two columns: Claude fills row one, so index 1 starts row two.
    expect(startGridStep("ArrowDown", 0, 6, true, 2)).toBe(1);
    expect(startGridStep("ArrowDown", 1, 8, false, 4)).toBe(5);
  });

  it("clamps at the ends and jumps with meta", () => {
    expect(startGridStep("ArrowLeft", 0, 8, true, 3)).toBe(0);
    expect(startGridStep("ArrowRight", 7, 8, true, 3)).toBe(7);
    expect(startGridStep("End", 0, 8, true, 3, true)).toBe(7);
    expect(startGridStep("Home", 6, 8, true, 3, true)).toBe(0);
  });

  it("starts at the first card when the selection is filtered out, and ignores other keys", () => {
    expect(startGridStep("ArrowDown", -1, 8, true, 3)).toBe(0);
    expect(startGridStep("Enter", 2, 8, true, 3)).toBeNull();
  });
});

describe("selectionAfterFilter", () => {
  it("keeps a pick that is still listed", () => {
    expect(selectionAfterFilter("b", ["a", "b"])).toBe("b");
  });

  it("moves to the first card when the filter hides the pick", () => {
    expect(selectionAfterFilter("c", ["a", "b"])).toBe("a");
  });

  it("keeps the pick when nothing is listed", () => {
    expect(selectionAfterFilter("c", [])).toBe("c");
  });
});

describe("startAfterSearch", () => {
  const entry = (id: string, category: TemplateEntry["category"], haystack: string) =>
    ({ id, source: "bundled", category, tier: "free", haystack }) as unknown as TemplateEntry;
  const entries = [
    entry("product-tour", "feature", "product tour walkthrough"),
    entry("release-notes", "update", "release notes changelog"),
    entry("launch-teaser", "launch", "launch teaser countdown"),
  ];

  it("moves the selection off a template the search hides", () => {
    expect(startAfterSearch(entries, null, "release", "product-tour", false)).toEqual({
      chip: null,
      selected: "release-notes",
    });
  });

  it("keeps a selection the search still shows", () => {
    expect(startAfterSearch(entries, null, "tour", "product-tour", true)).toEqual({
      chip: null,
      selected: "product-tour",
    });
  });

  it("returns the chips to All while typing and follows the wider listing", () => {
    expect(startAfterSearch(entries, "feature", "teaser", "product-tour", false)).toEqual({
      chip: null,
      selected: "launch-teaser",
    });
  });

  it("keeps the chip when the search clears", () => {
    expect(startAfterSearch(entries, "update", "", "release-notes", false)).toEqual({
      chip: "update",
      selected: "release-notes",
    });
  });

  it("lands on Create with Claude when the search still matches it", () => {
    expect(startAfterSearch(entries, null, "blank", "product-tour", true)).toEqual({
      chip: null,
      selected: CLAUDE_START_ID,
    });
  });

  it("keeps the pick when nothing matches", () => {
    expect(startAfterSearch(entries, null, "zzz", "product-tour", true).selected).toBe(
      "product-tour",
    );
  });
});

describe("lookChoices", () => {
  const choices = [
    choice("studio", "bundled", "light"),
    choice("midnight", "bundled", "dark"),
    choice("ws:brand", "workspace", "dark"),
  ];

  it("leads with the user's own themes", () => {
    expect(lookChoices(choices, "all").map(({ id }) => id)).toEqual([
      "ws:brand",
      "studio",
      "midnight",
    ]);
  });

  it("filters to yours, light or dark", () => {
    expect(lookChoices(choices, "yours").map(({ id }) => id)).toEqual(["ws:brand"]);
    expect(lookChoices(choices, "dark").map(({ id }) => id)).toEqual(["ws:brand", "midnight"]);
    expect(lookChoices(choices, "light").map(({ id }) => id)).toEqual(["studio"]);
  });

  it("puts a template's looks first, in its order, under every filter", () => {
    const looks = ["midnight", "gone", "studio"];
    expect(lookChoices(choices, "all", looks).map(({ id }) => id)).toEqual([
      "midnight",
      "studio",
      "ws:brand",
    ]);
    expect(lookChoices(choices, "dark", looks).map(({ id }) => id)).toEqual([
      "midnight",
      "ws:brand",
    ]);
  });
});

describe("availableLooks", () => {
  it("keeps the looks the listing has, once each, in the template's order", () => {
    const choices = [choice("studio", "bundled", "light"), choice("midnight", "bundled", "dark")];
    expect(availableLooks(choices, ["midnight", "hidden", "studio", "midnight"])).toEqual([
      "midnight",
      "studio",
    ]);
  });
});

describe("lookSelection", () => {
  it("keeps the user's pick through a template change", () => {
    expect(lookSelection("midnight", { looksKey: "a", id: "studio" }, "b", "dusk")).toBe(
      "midnight",
    );
  });

  it("holds the look a step showed, and re-seeds once the template's looks change", () => {
    const shown = { looksKey: "a|b", id: "a" };
    expect(lookSelection(null, shown, "a|b", "ws:late")).toBe("a");
    expect(lookSelection(null, shown, "c", "c")).toBe("c");
    expect(lookSelection(null, null, "c", "c")).toBe("c");
  });
});

describe("initialLookThemeId", () => {
  it("picks the user's first theme, else the app default", () => {
    expect(initialLookThemeId([choice("studio", "bundled", "light")])).toBe(DEFAULT_THEME_ID);
    expect(
      initialLookThemeId([
        choice("studio", "bundled", "light"),
        choice("ws:a", "workspace", "dark"),
      ]),
    ).toBe("ws:a");
  });

  it("prefers the template's first available look over the user's own", () => {
    const choices = [choice("studio", "bundled", "light"), choice("ws:a", "workspace", "dark")];
    expect(initialLookThemeId(choices, ["hidden", "studio"])).toBe("studio");
    expect(initialLookThemeId(choices, ["hidden"])).toBe("ws:a");
  });
});
