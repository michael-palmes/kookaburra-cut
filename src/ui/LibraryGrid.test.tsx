import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryGrid } from "./LibraryGrid";
import { libraryCardMenuItems } from "./libraryMenus";

afterEach(() => vi.unstubAllEnvs());

describe("bundled library in a release build", () => {
  it.each(["template", "preset"] as const)("offers an editable copy of each %s", (kind) => {
    vi.stubEnv("DEV", false);
    const html = renderToStaticMarkup(
      <LibraryGrid
        kind={kind}
        source="bundled"
        query=""
        onOpen={vi.fn()}
        onNewProjectFrom={vi.fn()}
        onEditDetails={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(html).toContain("Edit a copy");
    expect(html).not.toContain(">Manage<");
  });

  it("exposes copy and create actions without bundled mutations", () => {
    const items = libraryCardMenuItems({
      kind: "template",
      source: "bundled",
      writable: false,
      onOpen: vi.fn(),
      onNewProject: vi.fn(),
      onEditDetails: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(items.map((item) => (item === "separator" ? item : item.id))).toEqual([
      "new-project",
      "duplicate",
    ]);
  });
});

describe("library card moves", () => {
  it("seat Move up and Move down between the copies and Delete", () => {
    const down = vi.fn();
    const items = libraryCardMenuItems({
      kind: "preset",
      source: "user",
      writable: true,
      onOpen: vi.fn(),
      onEditDetails: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
      moves: { up: null, down },
    });
    expect(items.map((item) => (item === "separator" ? "|" : item.id))).toEqual([
      "open",
      "details",
      "duplicate",
      "|",
      "move-up",
      "move-down",
      "|",
      "delete",
    ]);
    const up = items.find((item) => item !== "separator" && item.id === "move-up");
    expect(up !== "separator" && up?.disabled).toBe(true);
    const move = items.find((item) => item !== "separator" && item.id === "move-down");
    if (move && move !== "separator") move.onSelect();
    expect(down).toHaveBeenCalledOnce();
  });
});
