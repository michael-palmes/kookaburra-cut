import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemeMode } from "./ThemeMode";

const actions = () => ({
  onDuplicate: vi.fn().mockResolvedValue("ws-theme:new"),
  onThemeEdited: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
});

describe("theme library", () => {
  it("can create, duplicate and edit themes without an open project", () => {
    const html = renderToStaticMarkup(<ThemeMode {...actions()} />);
    expect(html).toContain('aria-label="Themes"');
    expect(html).toContain("New theme…");
    expect(html).toContain("Duplicate…");
    expect(html).toContain("Edit…");
    expect(html).not.toContain("Apply theme");
    expect(html).not.toContain("Project theme");
  });

  it("keeps project application available when opened from the editor", () => {
    const html = renderToStaticMarkup(
      <ThemeMode
        {...actions()}
        currentThemeId="kookaburra-noir"
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(html).toContain('aria-label="Project theme"');
    expect(html).toContain("Apply theme");
  });
});
