import { describe, expect, it } from "vitest";
import {
  ALL_PROJECTS,
  filterProjectLibrary,
  projectGroupRows,
  selectedProjectGroup,
  UNGROUPED_PROJECTS,
} from "./projectLibrary";

const projects = [
  { name: "Launch film", slug: "launch-film", group: "Client work" },
  { name: "Product tour", slug: "product-tour", group: "Marketing" },
  { name: "Release notes", slug: "release-notes", group: "Client work" },
  { name: "Scratch project", slug: "scratch-project", group: null },
];

describe("projectGroupRows", () => {
  it("lists the fixed rows followed by sorted manual groups with live counts", () => {
    expect(projectGroupRows(projects)).toEqual([
      { id: ALL_PROJECTS, label: "All", count: 4 },
      { id: UNGROUPED_PROJECTS, label: "Ungrouped", count: 1 },
      { id: "group:Client work", label: "Client work", count: 2 },
      { id: "group:Marketing", label: "Marketing", count: 1 },
    ]);
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

describe("selectedProjectGroup", () => {
  it("inherits only a manual group", () => {
    expect(selectedProjectGroup("group:Client work")).toBe("Client work");
    expect(selectedProjectGroup(ALL_PROJECTS)).toBeUndefined();
    expect(selectedProjectGroup(UNGROUPED_PROJECTS)).toBeUndefined();
  });
});
