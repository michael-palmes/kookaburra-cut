import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type SceneManagerRow, ScenesDrillIn } from "./ScenesDrillIn";

const scenes: SceneManagerRow[] = [
  { index: 0, name: "Title", durationMs: 500, hasDoc: true },
  { index: 1, name: "Device", durationMs: 500, hasDoc: true },
  { index: 2, name: "Outro", durationMs: 500, hasDoc: false },
];

function render(busy = false, canAddScenes = true) {
  return renderToStaticMarkup(
    <ScenesDrillIn
      scenes={scenes}
      busy={busy}
      canAddScenes={canAddScenes}
      onBack={vi.fn()}
      onReorder={vi.fn()}
      onDuplicate={vi.fn()}
      onRename={vi.fn()}
      onDuration={vi.fn()}
      onDuplicateDialog={vi.fn()}
      onCopyBackground={vi.fn()}
      onPasteBackground={vi.fn()}
      onDelete={vi.fn()}
      onCopyToProject={vi.fn()}
      onCopyFromProject={vi.fn()}
      onInsertPreset={vi.fn()}
      onSaveAsPreset={vi.fn()}
    />,
  );
}

function footer(html: string) {
  return html.slice(html.indexOf('class="inspector-drill-actions"'));
}

describe("ScenesDrillIn", () => {
  it("seats Copy from, From preset, Duplicate and Delete buttons in the footer", () => {
    const html = render();
    expect(html).toContain('class="inspector-drill-actions"');
    expect(html).toContain("Copy from…<");
    expect(html).toContain("From preset");
    expect(html).toContain(">Duplicate<");
    expect(html).toContain(">Delete<");
    expect(html).toContain('class="btn btn-left"');
    expect(html).toContain('class="btn scene-manager-delete"');
  });

  it("gives every footer button a leading icon", () => {
    expect(footer(render()).match(/viewBox="0 0 20 20"/g)).toHaveLength(4);
  });

  it("disables the selection actions with nothing selected, never Copy from or the preset insert", () => {
    expect(footer(render()).match(/disabled=""/g)).toHaveLength(2);
  });

  it("disables the whole footer while an op is in flight", () => {
    const html = footer(render(true));
    expect(html).toContain(">Working…<");
    expect(html.match(/disabled=""/g)).toHaveLength(4);
  });

  it("keeps presets editable without additive scene actions", () => {
    const html = render(false, false);
    expect(html).not.toContain("Copy from…<");
    expect(html).not.toContain("From preset");
    expect(html).not.toContain(">Duplicate<");
    expect(html).toContain("Title");
    expect(html).toContain(">Delete<");
  });

  it("renders one row per scene with its length", () => {
    const html = render();
    expect(html.match(/class="scene-manager-row"/g)).toHaveLength(3);
    expect(html).toContain("0:00.50");
  });
});
