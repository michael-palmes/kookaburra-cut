import { describe, expect, it } from "vitest";
import {
  claudeStartMatches,
  DEFAULT_THEME_ID,
  defaultProjectName,
  initialLookThemeId,
  lookChoices,
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

describe("startGridStep", () => {
  // With the Claude card: row one is Claude (two cells) + index 1; row two is 2, 3, 4.
  it("moves down and up through the wide lead card", () => {
    expect(startGridStep("ArrowDown", 0, 8, true)).toBe(2);
    expect(startGridStep("ArrowDown", 1, 8, true)).toBe(4);
    expect(startGridStep("ArrowUp", 3, 8, true)).toBe(0);
    expect(startGridStep("ArrowUp", 4, 8, true)).toBe(1);
    expect(startGridStep("ArrowUp", 1, 8, true)).toBe(1);
  });

  it("walks a plain three-column grid", () => {
    expect(startGridStep("ArrowDown", 1, 8, false)).toBe(4);
    expect(startGridStep("ArrowDown", 6, 8, false)).toBe(7);
    expect(startGridStep("End", 3, 8, false)).toBe(5);
    expect(startGridStep("Home", 5, 8, false)).toBe(3);
  });

  it("clamps at the ends and jumps with meta", () => {
    expect(startGridStep("ArrowLeft", 0, 8, true)).toBe(0);
    expect(startGridStep("ArrowRight", 7, 8, true)).toBe(7);
    expect(startGridStep("End", 0, 8, true, true)).toBe(7);
    expect(startGridStep("Home", 6, 8, true, true)).toBe(0);
  });

  it("starts at the first card when the selection is filtered out, and ignores other keys", () => {
    expect(startGridStep("ArrowDown", -1, 8, true)).toBe(0);
    expect(startGridStep("Enter", 2, 8, true)).toBeNull();
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
});
