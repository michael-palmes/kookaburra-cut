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
    expect(styles).toContain(".text-inspector-icon-takeover {");
  });
});
