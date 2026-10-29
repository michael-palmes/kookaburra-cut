import { describe, expect, it } from "vitest";
import { reviewPackSceneDocs } from "./packReview";

describe("reviewPackSceneDocs", () => {
  it("reviews each item's sidecars in its own group and names templates and presets", () => {
    const { terminals, websites } = reviewPackSceneDocs([
      {
        kind: "project",
        slug: "launch",
        name: "Launch",
        file: "scenes/01-demo.tsx",
        doc: { terminal: { startCommand: "pnpm dev" }, website: { url: "https://example.com" } },
      },
      {
        kind: "template",
        slug: "demo",
        name: "Demo",
        file: "scenes/01-demo.tsx",
        doc: { name: "Hero", terminal: { startCommand: "ls" } },
      },
      {
        kind: "preset",
        slug: "quiet",
        name: "Quiet",
        file: "scenes/01-quiet.tsx",
        doc: { terminal: { snapshot: null } },
      },
      { kind: "project", slug: "broken", name: "Broken", file: "scenes/01.tsx", doc: null },
    ]);
    expect(terminals.map((row) => [row.project, row.scene, row.command])).toEqual([
      ["Launch", "01-demo", "pnpm dev"],
      ["Demo (template)", "Hero", "ls"],
    ]);
    expect(websites.map((row) => [row.project, row.origins[0]?.origin])).toEqual([
      ["Launch", "https://example.com"],
    ]);
  });

  it("is empty when no sidecar carries a command, a start path or an origin", () => {
    expect(
      reviewPackSceneDocs([
        { kind: "project", slug: "a", name: "A", file: "scenes/01.tsx", doc: { text: {} } },
      ]),
    ).toEqual({ terminals: [], websites: [] });
  });
});
