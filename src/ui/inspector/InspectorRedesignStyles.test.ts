import { describe, expect, it } from "vitest";

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

describe("inspector redesign styles", () => {
  it("keeps the lighting direction dial at the handoff geometry", () => {
    expect(styles).toMatch(/\.lighting-direction-dial\s*{[^}]*width: 96px;[^}]*height: 96px;/s);
    expect(styles).toContain(".lighting-direction-dial::before {");
    expect(styles).toContain(".lighting-direction-subject::before,");
    expect(styles).toContain(".lighting-direction-camera,");
    expect(styles).toContain(".lighting-direction-sun {");
    expect(styles).toContain(".lighting-direction-value {");
  });

  it("styles the new inspector-only layout hooks", () => {
    expect(styles).toContain(".arrange-devices-body {");
    expect(styles).toMatch(/\.device-editor-preview-card\s*{[^}]*flex: none;/s);
    expect(styles).toMatch(/\.device-editor-media-thumb img\s*\{[^}]*object-fit: contain;/s);
    expect(styles).toContain(".text-inspector-icon-takeover {");
    expect(styles).toMatch(
      /\.text-inspector-type-segments,\s*\.text-inspector-alignment-segments,[^{]*\{[^}]*align-self: stretch;[^}]*margin: 0 8px;/s,
    );
    expect(styles).toMatch(
      /\.text-inspector-alignment-segments \.inspector-subtab,[^{]*\{[^}]*flex: 1;/s,
    );
    expect(styles).toMatch(
      /\.text-inspector-single-controls\s*\{[^}]*display: flex;[^}]*flex-direction: column;/s,
    );
    expect(styles).toMatch(/\.text-inspector-add-line\s*\{[^}]*margin-left: auto;/s);
    expect(styles).toMatch(
      /\.inspector-drill-header-action\s*\{[^}]*width: 26px;[^}]*height: 26px;/s,
    );
    expect(styles).toMatch(
      /\.inspector-drill-header-action\.danger\s*\{[^}]*color: var\(--danger\);/s,
    );
    expect(styles).toMatch(
      /\.inspector-device-switcher\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    );
    expect(styles).toMatch(
      /\.inspector-device-switch-preview img\s*\{[^}]*height: 104px;[^}]*object-fit: contain;/s,
    );
    expect(styles).toContain(".inspector-device-switch-name {");
    expect(styles).not.toContain(".device-editor-actions {");
    expect(styles).not.toContain(".text-inspector-footer {");
  });

  it("keeps compact theme collection controls at their full height", () => {
    expect(styles).toMatch(
      /\.theme-browser-chips\s*\{[^}]*flex: none;[^}]*min-height: var\(--control-h-sm\);/s,
    );
  });

  it("keeps the scene manager's footer delete red and its icon unshrunk", () => {
    expect(styles).toMatch(/\.scene-manager-delete\s*\{[^}]*color: var\(--danger\);/s);
    expect(styles).toMatch(/\.inspector-drill-actions \.btn svg\s*\{[^}]*flex: none;/s);
  });

  it("seats the glyph beside the label on the comparison motion chips", () => {
    expect(styles).toMatch(
      /\.compare-preset-chip\s*\{[^}]*display: inline-flex;[^}]*align-items: center;/s,
    );
  });

  it("gives the divider ease picker the rest of its row", () => {
    expect(styles).toMatch(/\.compare-ease-row \.modal-input\s*\{[^}]*flex: 1;[^}]*min-width: 0;/s);
  });

  it("removes native fieldset chrome and overflow from Lighting controls", () => {
    expect(styles).toMatch(
      /\[data-lighting-screen\] fieldset\.option-grid,\s*\[data-lighting-screen\] \.lighting-sun-controls\s*\{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*margin: 0;[^}]*border: 0;/s,
    );
    expect(styles).toMatch(
      /\[data-lighting-screen\] \.lighting-sun-controls\s*\{[^}]*padding: 0;/s,
    );
  });
});
