import { describe, expect, it } from "vitest";
import type { LoadedProject } from "../../engine/project";
import {
  collectProjectColours,
  PROJECT_PALETTE_CAP,
  projectPaletteColours,
  setProjectPaletteSource,
} from "./projectPalette";

// The scan only reads authored values, so a hand-built shape stands in for a real load.
const source = (parts: Record<string, unknown>) =>
  parts as unknown as Parameters<typeof collectProjectColours>[0];

describe("collectProjectColours", () => {
  it("orders by how often each colour is used", () => {
    expect(
      collectProjectColours(
        source({
          sceneDocs: [
            { background: { colour: "#ff0000" }, text: "#00ff00" },
            { background: { colour: "#ff0000" }, text: "#00ff00" },
            { background: { colour: "#ff0000" }, text: "#0000ff" },
          ],
        }),
      ),
    ).toEqual(["#ff0000", "#00ff00", "#0000ff"]);
  });

  it("breaks ties on first-seen order across the scene docs", () => {
    expect(
      collectProjectColours(
        source({ sceneDocs: [{ a: "#111111" }, { a: "#222222" }, { a: "#333333" }] }),
      ),
    ).toEqual(["#111111", "#222222", "#333333"]);
  });

  it("merges shorthand and mixed case into one entry", () => {
    expect(
      collectProjectColours(source({ sceneDocs: [{ a: "#ABC", b: "#aabbcc" }, { c: "#AABBCC" }] })),
    ).toEqual(["#aabbcc"]);
  });

  it("ignores everything that is not a hex colour", () => {
    expect(
      collectProjectColours(
        source({
          sceneDocs: [
            {
              token: "accent",
              keyword: "transparent",
              short: "#12345",
              bad: "#gg1122",
              fn: "rgb(0,0,0)",
              asset: "assets/hero.png",
              count: 42,
              missing: null,
              absent: undefined,
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("finds colours nested in arrays of objects", () => {
    expect(
      collectProjectColours(
        source({
          sceneDocs: [
            {
              chart: { data: { series: [{ colour: "#112233" }, { colour: "#112233" }] } },
              decorations: [{ fill: "#445566" }],
            },
          ],
          projectLighting: { lights: [{ colour: "#778899" }] },
        }),
      ),
    ).toEqual(["#112233", "#445566", "#778899"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      fill: `#${i.toString(16).padStart(2, "0")}0000`,
    }));
    const colours = collectProjectColours(source({ sceneDocs: many }));
    expect(colours).toHaveLength(PROJECT_PALETTE_CAP);
  });

  it("ignores prose that happens to spell a hex", () => {
    expect(
      collectProjectColours(
        source({
          sceneDocs: [
            { title: "Feb", subtitle: "Decade", label: "202608", tick: "100" },
            { background: { colour: "#ff0000" } },
          ],
        }),
      ),
    ).toEqual(["#ff0000"]);
  });

  it("returns nothing without a project", () => {
    expect(collectProjectColours(null)).toEqual([]);
  });
});

describe("projectPaletteColours", () => {
  const project = (docs: unknown) => ({ sceneDocs: docs }) as unknown as LoadedProject;

  it("memoises the scan per project identity", () => {
    const one = project([{ a: "#ff0000" }]);
    setProjectPaletteSource(one);
    const first = projectPaletteColours();
    expect(first).toEqual(["#ff0000"]);
    expect(projectPaletteColours()).toBe(first);

    const two = project([{ a: "#00ff00" }]);
    setProjectPaletteSource(two);
    const second = projectPaletteColours();
    expect(second).not.toBe(first);
    expect(second).toEqual(["#00ff00"]);

    setProjectPaletteSource(null);
    expect(projectPaletteColours()).toEqual([]);
  });
});
