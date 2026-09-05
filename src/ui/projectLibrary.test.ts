import { describe, expect, it } from "vitest";
import {
  ALL_PROJECTS,
  filterProjectLibrary,
  LIBRARY_APP_PRESETS,
  LIBRARY_APP_TEMPLATES,
  LIBRARY_PRESETS,
  LIBRARY_TEMPLATES,
  librarySection,
  nextWelcomeRailRow,
  projectGroupRows,
  selectedProjectGroup,
  sortProjectsByRecency,
  sortProjectsByUpdated,
  UNGROUPED_PROJECTS,
  welcomeRailRows,
  welcomeRailSections,
} from "./projectLibrary";

const projects = [
  { name: "Launch film", slug: "launch-film", group: "Client work" },
  { name: "Product tour", slug: "product-tour", group: "Marketing" },
  { name: "Release notes", slug: "release-notes", group: "Client work" },
  { name: "Scratch project", slug: "scratch-project", group: null },
];

const counts = { templates: 2, presets: 1, appTemplates: 15, appPresets: 0 };

describe("projectGroupRows", () => {
  it("lists the fixed rows followed by sorted manual groups with live counts", () => {
    expect(projectGroupRows(projects)).toEqual([
      { id: ALL_PROJECTS, label: "All", count: 4, iconId: "all" },
      { id: UNGROUPED_PROJECTS, label: "Ungrouped", count: 1, iconId: "ungrouped" },
      { id: "group:Client work", label: "Client work", count: 2, iconId: "group" },
      { id: "group:Marketing", label: "Marketing", count: 1, iconId: "group" },
    ]);
  });
});

describe("welcomeRailSections", () => {
  it("keeps bundled content accessible for browsing and editable copies", () => {
    const rows = welcomeRailRows(welcomeRailSections(projects, counts)).map((row) => row.id);
    expect(rows).toEqual([
      ALL_PROJECTS,
      UNGROUPED_PROJECTS,
      "group:Client work",
      "group:Marketing",
      LIBRARY_TEMPLATES,
      LIBRARY_PRESETS,
      LIBRARY_APP_TEMPLATES,
      LIBRARY_APP_PRESETS,
    ]);
  });

  it("includes live counts for both user and bundled catalogues", () => {
    const sections = welcomeRailSections(projects, counts);
    expect(sections.map((section) => section.label)).toEqual(["Projects", "Library"]);
    expect(sections[1].rows.map((row) => [row.id, row.count])).toEqual([
      [LIBRARY_TEMPLATES, 2],
      [LIBRARY_PRESETS, 1],
      [LIBRARY_APP_TEMPLATES, 15],
      [LIBRARY_APP_PRESETS, 0],
    ]);
  });
});

describe("librarySection", () => {
  it("names the catalogue behind a library row and nothing else", () => {
    expect(librarySection(LIBRARY_TEMPLATES)).toEqual({ kind: "template", source: "user" });
    expect(librarySection(LIBRARY_APP_PRESETS)).toEqual({ kind: "preset", source: "bundled" });
    expect(librarySection(ALL_PROJECTS)).toBeNull();
    expect(librarySection("group:Client work")).toBeNull();
  });
});

describe("nextWelcomeRailRow", () => {
  const rows = welcomeRailRows(welcomeRailSections(projects, counts));

  it("rolls across the section boundary", () => {
    expect(nextWelcomeRailRow(rows, "group:Marketing", "ArrowDown")?.id).toBe(LIBRARY_TEMPLATES);
    expect(nextWelcomeRailRow(rows, LIBRARY_TEMPLATES, "ArrowUp")?.id).toBe("group:Marketing");
  });

  it("clamps at both ends and answers Home/End", () => {
    expect(nextWelcomeRailRow(rows, ALL_PROJECTS, "ArrowUp")?.id).toBe(ALL_PROJECTS);
    expect(nextWelcomeRailRow(rows, LIBRARY_APP_PRESETS, "ArrowDown")?.id).toBe(
      LIBRARY_APP_PRESETS,
    );
    expect(nextWelcomeRailRow(rows, LIBRARY_PRESETS, "Home")).toEqual({
      id: ALL_PROJECTS,
      index: 0,
    });
    expect(nextWelcomeRailRow(rows, ALL_PROJECTS, "End")?.id).toBe(LIBRARY_APP_PRESETS);
  });

  it("ignores keys the rail does not own", () => {
    expect(nextWelcomeRailRow(rows, ALL_PROJECTS, "Enter")).toBeNull();
  });
});

describe("filterProjectLibrary", () => {
  it("composes the selected group with name and slug search", () => {
    expect(filterProjectLibrary(projects, "group:Client work", "release")).toEqual([projects[2]]);
    expect(filterProjectLibrary(projects, UNGROUPED_PROJECTS, "scratch-project")).toEqual([
      projects[3],
    ]);
    expect(filterProjectLibrary(projects, ALL_PROJECTS, "tour")).toEqual([projects[1]]);
  });
});

describe("sortProjectsByRecency", () => {
  const rows = [
    { name: "Beta", lastOpenedMs: 200 },
    { name: "Never opened", lastOpenedMs: null },
    { name: "Alpha", lastOpenedMs: 200 },
    { name: "Newest", lastOpenedMs: 900 },
    { name: "Also never", lastOpenedMs: null },
  ];

  it("orders most recent first, breaking ties and never-opened projects by name", () => {
    expect(sortProjectsByRecency(rows).map((p) => p.name)).toEqual([
      "Newest",
      "Alpha",
      "Beta",
      "Also never",
      "Never opened",
    ]);
  });

  it("leaves the caller's array alone", () => {
    const input = [...rows];
    sortProjectsByRecency(input);
    expect(input).toEqual(rows);
  });
});

describe("sortProjectsByUpdated", () => {
  const rows = [
    { name: "Stale", contentMtimeMs: 100, lastOpenedMs: 900 },
    { name: "Fresh", contentMtimeMs: 800, lastOpenedMs: null },
    { name: "Opened only", contentMtimeMs: null, lastOpenedMs: 500 },
    { name: "Alpha tie", contentMtimeMs: 800, lastOpenedMs: null },
    { name: "Untouched", contentMtimeMs: null, lastOpenedMs: null },
  ];

  it("orders by content edit first, falls back to last opened, ties by name", () => {
    expect(sortProjectsByUpdated(rows).map((p) => p.name)).toEqual([
      "Alpha tie",
      "Fresh",
      "Opened only",
      "Stale",
      "Untouched",
    ]);
  });

  it("leaves the caller's array alone", () => {
    const input = [...rows];
    sortProjectsByUpdated(input);
    expect(input).toEqual(rows);
  });
});

describe("selectedProjectGroup", () => {
  it("inherits only a manual group", () => {
    expect(selectedProjectGroup("group:Client work")).toBe("Client work");
    expect(selectedProjectGroup(ALL_PROJECTS)).toBeUndefined();
    expect(selectedProjectGroup(UNGROUPED_PROJECTS)).toBeUndefined();
  });
});
