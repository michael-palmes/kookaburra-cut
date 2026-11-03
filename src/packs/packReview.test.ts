import { describe, expect, it } from "vitest";
import { reviewPackSceneDocs } from "./packReview";

describe("reviewPackSceneDocs", () => {
  it("reviews each item's sidecars in its own group and names templates and presets", () => {
    const { websites } = reviewPackSceneDocs([
      {
        kind: "project",
        slug: "launch",
        name: "Launch",
        file: "scenes/01-demo.tsx",
        doc: { terminal: { transcript: "$ ls" }, website: { url: "https://example.com" } },
      },
      {
        kind: "template",
        slug: "demo",
        name: "Demo",
        file: "scenes/01-demo.tsx",
        doc: { name: "Hero", website: { url: "https://example.org" } },
      },
      { kind: "project", slug: "broken", name: "Broken", file: "scenes/01.tsx", doc: null },
    ]);
    expect(websites.map((row) => [row.project, row.origins[0]?.origin])).toEqual([
      ["Launch", "https://example.com"],
      ["Demo (template)", "https://example.org"],
    ]);
  });

  it("is empty when no sidecar carries an origin", () => {
    expect(
      reviewPackSceneDocs([
        { kind: "project", slug: "a", name: "A", file: "scenes/01.tsx", doc: { text: {} } },
      ]),
    ).toEqual({ websites: [] });
  });
});
