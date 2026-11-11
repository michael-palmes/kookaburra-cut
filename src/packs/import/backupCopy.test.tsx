import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../engine/packs", () => ({ revealInFinder: vi.fn() }));

import { ConflictsView } from "./ConflictsView";
import { SummaryView } from "./SummaryView";

describe("import backups", () => {
  it("say how long a replaced item's backup is kept", () => {
    const html = renderToStaticMarkup(
      <ConflictsView
        plan={{
          items: [
            {
              kind: "project",
              slug: "product-tour",
              name: "Product tour",
              state: "theirs-newer",
              defaultResolution: "replace",
              resolution: "replace",
            },
          ],
        }}
        onBack={() => {}}
        onApply={() => {}}
      />,
    );
    expect(html).toContain("kept for a day");
  });

  it("say when the backups go once the import is done", () => {
    const html = renderToStaticMarkup(
      <SummaryView
        outcome={{
          results: [
            { kind: "project", slug: "product-tour", name: "Product tour", outcome: "replaced" },
          ],
          backupDir: "/Users/x/Kookaburra Cut/.kookaburra/import-backup/run",
          notes: [],
        }}
        queued={0}
        onOpenProject={() => {}}
        onNextPack={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("in a backup for a day");
  });
});
