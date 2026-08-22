import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnusedMediaSheet } from "./UnusedMediaSheet";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const styles = testProcess
  .getBuiltinModule("fs")
  .readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("UnusedMediaSheet", () => {
  it("names itself as a modal dialog and opens on the scan", () => {
    const html = renderToStaticMarkup(
      <UnusedMediaSheet
        slug="demo"
        metas={{}}
        editedRels={new Set()}
        onDeleted={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Delete unused media"');
    expect(html).toContain('class="modal-overlay"');
    expect(html).toContain('class="modal unused-media-modal"');
    expect(html).toContain("Checking what&#x27;s used…");
    expect(html).toContain('aria-live="polite"');
  });

  it("scrolls the list, not the sheet, and beats the base modal width", () => {
    expect(styles).toMatch(/\.unused-list\s*\{[^}]*overflow-y:\s*auto/s);
    // Compound selector: a bare `.unused-media-modal` loses to `.modal`'s 30rem at equal specificity.
    expect(styles).toContain(".modal.unused-media-modal {");
  });
});
