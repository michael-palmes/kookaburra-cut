import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opensContextMenu } from "./ContextMenu";
import { OptionCard } from "./OptionCard";

/** WCAG 2.2 AA guards for the chrome (docs/accessibility.md). DOM behaviour this node suite can't mount is pinned to the source. */

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const read = (path: string) =>
  testProcess.getBuiltinModule("fs").readFileSync(new URL(path, import.meta.url), "utf8");
const styles = read("../styles.css");

function token(name: string): string {
  const m = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i"));
  if (!m?.[1]) throw new Error(`no hex token --${name}`);
  return m[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["window", "panel", "panel-alt", "recessed", "raised", "elevated"];

describe("chrome contrast (1.4.3, 1.4.11)", () => {
  it.each(["text-primary", "text-secondary", "text-tertiary", "accent-text", "danger-text"])(
    "--%s reads at 4.5:1 or better on every surface tier",
    (text) => {
      for (const surface of SURFACES) {
        expect(contrast(token(text), token(`surface-${surface}`))).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("keeps the focus ring at 3:1 or better on every surface tier", () => {
    for (const surface of SURFACES) {
      expect(contrast(token("focus-ring"), token(`surface-${surface}`))).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the disabled grey off running text", () => {
    for (const rule of [".welcome-legal {", ".version-label {"]) {
      const body = styles.slice(styles.indexOf(rule), styles.indexOf("}", styles.indexOf(rule)));
      expect(body).toContain("color: var(--text-tertiary);");
    }
  });
});

describe("focus visible (2.4.7)", () => {
  it.each([".palette-input:focus {", ".range-value-edit {", ".chart-series-name:focus {"])(
    "%s keeps the global focus ring",
    (rule) => {
      const body = styles.slice(styles.indexOf(rule), styles.indexOf("}", styles.indexOf(rule)));
      expect(body).not.toContain("outline: none");
    },
  );
});

describe("hidden chrome leaves the tab order (2.4.3, 4.1.2)", () => {
  it("makes the closed animation lane inert", () => {
    expect(read("./TrackLane.tsx")).toMatch(/aria-hidden=\{!open\}\s*inert=\{!open\}/);
  });

  it.each(["./CameraPill.tsx", "./LayeredScreenshotPill.tsx"])(
    "makes %s's closed controls inert",
    (file) => {
      expect(read(file)).toContain(
        '<div className="camera-pill-active" aria-hidden={!open} inert={!open}>',
      );
    },
  );

  it("names the command palette dialog", () => {
    expect(read("./CommandPalette.tsx")).toMatch(
      /role="dialog"\s*aria-modal="true"\s*aria-label="Command palette"/,
    );
  });

  it("routes every Escape layer through the modal focus manager", () => {
    const source = read("./useEscapeClose.ts");
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*syncModalFocus\(\);\s*return syncModalFocus;\s*\}, \[\]\);/,
    );
  });
});

describe("keyboard context menus (2.1.1)", () => {
  it("opens on the menu key and ⇧F10 only", () => {
    expect(opensContextMenu({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(opensContextMenu({ key: "F10", shiftKey: true })).toBe(true);
    expect(opensContextMenu({ key: "F10", shiftKey: false })).toBe(false);
    expect(opensContextMenu({ key: "Enter", shiftKey: true })).toBe(false);
  });
});

describe("option card clips (2.2.2, 2.3.3)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const card = () =>
    renderToStaticMarkup(
      <OptionCard
        label="Fade"
        image="poster.jpg"
        clip="clip.mp4"
        playing
        selected
        onSelect={vi.fn()}
      />,
    );

  it("loops the selected card's clip by default", () => {
    expect(card()).toContain("<video");
  });

  it("holds the still under Reduce motion until the card is hovered or focused", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const html = card();
    expect(html).not.toContain("<video");
    expect(html).toContain('src="poster.jpg"');
  });
});

describe("names and purposes (1.3.5, 4.1.2)", () => {
  it("marks the publisher fields with their input purpose", () => {
    const pane = read("../settings/PublisherPane.tsx");
    for (const [label, purpose] of [
      ["Publisher name", "name"],
      ["Organisation", "organization"],
      ["Website", "url"],
    ]) {
      expect(pane).toMatch(new RegExp(`aria-label="${label}"\\s*autoComplete="${purpose}"`));
    }
  });

  it("names the video editor's glyph buttons", () => {
    expect(read("../editor/EditorApp.tsx")).toContain('aria-label={playing ? "Pause" : "Play"}');
    const timeline = read("../editor/Timeline.tsx");
    expect(timeline).toContain('aria-label="Zoom out"');
    expect(timeline).toContain('aria-label="Zoom in"');
  });
});

describe("camera tool names (4.1.2)", () => {
  it.each(["./CameraPill.tsx", "./LayeredScreenshotPill.tsx"])(
    "%s names each tool by its short label, the tooltip stays the description",
    (file) => {
      expect(read(file)).toContain('aria-label={label.split(" (")[0]}');
    },
  );
});
