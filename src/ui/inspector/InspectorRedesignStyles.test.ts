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

  it("gives the content section's add control an accent-filled pill", () => {
    expect(styles).toMatch(
      /\.inspector-scene-overview-add\s*\{[^}]*height: var\(--control-h-sm\);[^}]*margin-left: auto;[^}]*color: var\(--text-on-accent\);[^}]*background: var\(--accent\);[^}]*border-radius: var\(--radius-full\);/s,
    );
    expect(styles).toMatch(/\.inspector-scene-overview-add svg\s*\{[^}]*width: 14px;/s);
    expect(styles).toMatch(
      /\.inspector-scene-overview-group-add,\s*\.inspector-scene-overview-entity-open\s*\{[^}]*background: transparent;/s,
    );
    expect(styles).not.toContain(".inspector-scene-overview-add,");
  });

  it("bands the Background drill so each band owns its overflow", () => {
    expect(styles).toMatch(
      /\.inspector-drill-body\.banded\s*\{[^}]*gap: 0;[^}]*padding: 0;[^}]*overflow: hidden;/s,
    );
    expect(styles).toMatch(
      /\.bg-type-strip\s*\{[^}]*height: 30px;[^}]*margin: 10px 12px;[^}]*background: var\(--surface-recessed\);/s,
    );
    expect(styles).toMatch(/\.bg-type-strip-tab svg\s*\{[^}]*width: 16px;[^}]*height: 16px;/s);
    expect(styles).toMatch(
      /\.bg-type-strip-tab\.selected\s*\{[^}]*background: var\(--surface-raised\);[^}]*border-color: var\(--border-strong\);/s,
    );
    expect(styles).toMatch(
      /\.bg-look-browser\s*\{[^}]*position: relative;[^}]*flex: 1;[^}]*min-height: 120px;[^}]*overflow-y: auto;/s,
    );
    expect(styles).toMatch(
      /\.bg-look-group-header\s*\{[^}]*position: sticky;[^}]*top: 0;[^}]*height: 28px;/s,
    );
    expect(styles).toMatch(
      /\.bg-look-grid\s*\{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[^}]*gap: 6px;/s,
    );
  });

  it("keeps the compact look tile and preset swatches at the handoff geometry", () => {
    expect(styles).toMatch(/\.theme-card\.compact \.theme-card-thumb\s*\{[^}]*height: 44px;/s);
    expect(styles).toMatch(
      /\.theme-card\.compact \.theme-card-meta\s*\{[^}]*font-size: 10\.5px;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s,
    );
    expect(styles).toMatch(
      /\.theme-card\.compact\.selected\s*\{[^}]*background: var\(--accent-subtle\);[^}]*border-color: var\(--accent-border\);/s,
    );
    expect(styles).toMatch(
      /\.bg-preset-strip-row\s*\{[^}]*overflow-x: auto;[^}]*scrollbar-width: none;/s,
    );
    expect(styles).not.toMatch(/\.bg-preset-strip-row\s*\{[^}]*flex-wrap/s);
    expect(styles).toMatch(/\.bg-preset-swatch\s*\{[^}]*width: 22px;[^}]*height: 22px;/s);
    expect(styles).toMatch(
      /\.bg-preset-swatch\.selected\s*\{[^}]*outline: 1\.5px solid var\(--accent\);[^}]*outline-offset: 2px;/s,
    );
    expect(styles).toMatch(/\.bg-preset-divider\s*\{[^}]*width: 1px;[^}]*height: 18px;/s);
  });

  it("pins the Options sheet between its bar and the clamp that spares the look browser", () => {
    expect(styles).toMatch(
      /\.bg-options-sheet\s*\{[^}]*height: 43px;[^}]*max-height: calc\(100% - 66px - 120px\);[^}]*overflow: hidden;[^}]*transition: height var\(--dur-base\) var\(--ease-standard\);/s,
    );
    expect(styles).toMatch(/\.bg-options-sheet\.open\s*\{[^}]*height: 480px;/s);
    expect(styles).toMatch(
      /\.bg-options-sheet\.open \.bg-options-sheet-chevron\s*\{[^}]*rotate\(90deg\)/s,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.bg-options-sheet,\s*\.bg-options-sheet-chevron\s*\{\s*transition: none;/s,
    );
    expect(styles).toMatch(
      /\.bg-options-sheet-body\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/s,
    );
    expect(styles).toMatch(
      /\.bg-sheet-slider\s*\{[^}]*grid-template-columns: 76px minmax\(0, 1fr\) 44px;/s,
    );
    expect(styles).toMatch(/\.bg-sheet-slider \.popover-inline\s*\{[^}]*display: contents;/s);
    expect(styles).toMatch(
      /\.bg-sheet-slider \.range-value\s*\{[^}]*font-family: var\(--font-mono\);/s,
    );
    expect(styles).toMatch(
      /\.inspector-subtabs\.bg-sheet-segmented\s*\{[^}]*height: 24px;[^}]*margin: 0;/s,
    );
    expect(styles).toMatch(/\.bg-sheet-segmented \.inspector-subtab svg\s*\{[^}]*width: 13px;/s);
    expect(styles).toMatch(/\.bg-options-sheet \.toggle-row\s*\{[^}]*height: 28px;/s);
    expect(styles).toMatch(
      /\.inspector-drill-header-action\.confirming\s*\{[^}]*width: auto;[^}]*padding: 0 8px;[^}]*font-size: var\(--text-xs\);[^}]*white-space: nowrap;/s,
    );
  });

  it("keeps the banded drill free of shadows, gradients and glows", () => {
    const start = styles.indexOf("/* ── Banded Background drill");
    const end = styles.indexOf(".arrange-devices-summary", start);
    const banded = styles.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(banded).not.toMatch(/box-shadow|gradient\(|filter:/);
  });

  it("makes room for the armed header confirm and keeps look-tile focus rings clear of sticky headers", () => {
    expect(styles).toMatch(
      /\.inspector-drill-header:has\(\.inspector-drill-header-action\.confirming\) \.inspector-drill-current\s*\{[^}]*display: none;/s,
    );
    expect(styles).toMatch(
      /\.inspector-drill-header:has\(\.inspector-drill-header-action\.confirming\)\s+\.inspector-drill-destination\s*\{[^}]*max-width: none;/s,
    );
    expect(styles).toMatch(/\.theme-card\.compact:focus-visible\s*\{[^}]*outline-offset: -2px;/s);
    expect(styles).toMatch(/\.theme-card-thumb > \*\s*\{[^}]*pointer-events: none;/s);
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
