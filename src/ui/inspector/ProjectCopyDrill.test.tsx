import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectCopyDrill } from "./ProjectCopyDrill";

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
  .readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

function render(sceneLabel = "“Title”") {
  return renderToStaticMarkup(
    <ProjectCopyDrill
      slug="launch-film"
      indices={[0]}
      sceneLabel={sceneLabel}
      onBack={vi.fn()}
      onDone={vi.fn()}
    />,
  );
}

describe("ProjectCopyDrill", () => {
  it("is a drill page, not a modal overlay", () => {
    const html = render();
    expect(html).toContain('class="inspector-drill"');
    expect(html).toContain('class="inspector-drill-body"');
    expect(html).not.toContain("modal-overlay");
  });

  it("titles itself Copy to project and returns to Scenes", () => {
    expect(render()).toContain('aria-label="Back to Scenes from Copy to project"');
  });

  it("names the selection in the hint", () => {
    expect(render("3 scenes")).toContain("Copying 3 scenes.");
  });

  it("reads the workspace before it can show any card", () => {
    expect(render()).toContain("Reading your workspace…");
  });

  it("styles the card grid it renders into", () => {
    for (const rule of [
      ".project-copy-grid {",
      ".project-copy-card {",
      ".project-copy-thumb {",
      ".project-copy-name {",
      ".project-copy-meta {",
    ]) {
      expect(styles).toContain(rule);
    }
  });
});
