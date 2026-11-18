import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opensContextMenu } from "./ContextMenu";
import { KeptLengthNote, keptLengthNote } from "./keptLength";
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

/** `top` at `alpha` over the opaque `base`, as the browser composites a translucent border. */
function over(base: string, top: string, alpha: number): string {
  const ch = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) => Math.round(ch(base, i) + (ch(top, i) - ch(base, i)) * alpha))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

function ruleBody(rule: string): string {
  const at = styles.indexOf(`\n${rule}`);
  if (at === -1) throw new Error(`no rule ${rule}`);
  return styles.slice(at, styles.indexOf("}", at));
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

  it("draws field and select outlines at 3:1 or better on every surface tier", () => {
    const m = styles.match(/--border-control: rgba\(255, 255, 255, ([0-9.]+)\);/);
    const alpha = Number(m?.[1]);
    for (const surface of SURFACES) {
      const base = token(`surface-${surface}`);
      expect(contrast(over(base, "#ffffff", alpha), base), surface).toBeGreaterThanOrEqual(3);
    }
    for (const rule of [
      ".select {",
      ".modal-input {",
      ".palette-input {",
      ".editor-hold-input {",
    ]) {
      expect(ruleBody(rule), rule).toContain("var(--border-control)");
    }
  });

  it("frames a selected chip or card at 3:1 against its surface and its own fill", () => {
    for (const surface of SURFACES) {
      const base = token(`surface-${surface}`);
      const fill = over(base, token("accent"), 0.15);
      expect(contrast(token("accent"), base), surface).toBeGreaterThanOrEqual(3);
      expect(contrast(token("accent"), fill), surface).toBeGreaterThanOrEqual(3);
    }
    for (const rule of [".chip.selected {", ".btn.selected {", ".theme-card.selected {"]) {
      expect(ruleBody(rule), rule).toContain("border-color: var(--accent);");
    }
  });

  it("lifts tertiary hints to secondary inside a hovered or selected row", () => {
    const at = styles.indexOf("/* A hovered or selected row's wash");
    const rule = styles.slice(at, styles.indexOf("}", at));
    for (const hint of [
      ".font-picker-row:is(:hover, .selected) .font-picker-style",
      ".template-card:is(:hover, .selected) .template-card-meta",
      ".text-motion-preset-card:is(:hover, .selected):not(:disabled) small",
    ]) {
      expect(rule, hint).toContain(hint);
    }
    expect(rule).toContain("color: var(--text-secondary);");
    for (const surface of SURFACES) {
      const base = token(`surface-${surface}`);
      for (const wash of [over(base, "#ffffff", 0.09), over(base, token("accent"), 0.15)]) {
        expect(contrast(token("text-secondary"), wash), surface).toBeGreaterThanOrEqual(4.5);
      }
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

  it("focuses a clicked scene row, so the menu key then opens that row's menu", () => {
    const source = read("./inspector/ScenesDrillIn.tsx");
    const down = source.slice(source.indexOf("function onRowPointerDown"));
    expect(down).toMatch(
      /if \(busy \|\| e\.button !== 0 \|\| renaming \|\| timing\) return;\s*e\.preventDefault\(\);[^\n]*\n[^\n]*\n\s*\(e\.currentTarget as HTMLElement\)\.focus\(\{ preventScroll: true \}\);/,
    );
    expect(source).toMatch(
      /if \(e\.target !== e\.currentTarget \|\| busy \|\| renaming \|\| timing\) return;\s*if \(opensContextMenu\(e\)\) \{/,
    );
    // A press inside a live rename or length field stays in that field.
    expect(source.match(/onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/g)).toHaveLength(2);
  });

  it("focuses a clicked ruler tap dot, so the menu key then opens its menu", () => {
    const source = read("../editor/Timeline.tsx");
    const dot = source.slice(source.indexOf('className="timeline-tap-dot"'));
    expect(dot).toMatch(
      /onPointerDown=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*\/\/[^\n]*\n\s*e\.currentTarget\.focus\(\{ preventScroll: true \}\);/,
    );
    expect(dot).toMatch(/if \(!onTapMenu \|\| !opensContextMenu\(e\)\) return;/);
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

  it("plays the selected card's clip once and holds its last frame", () => {
    const html = card();
    expect(html).toContain("<video");
    expect(html).toContain("autoPlay");
    expect(html).not.toMatch(/<video[^>]*\bloop\b/);
  });

  it("plays it again, looping, only while the card is hovered or focused", () => {
    const source = read("./OptionCard.tsx");
    expect(source).toContain("loop={near}");
    expect(source).toMatch(/if \(near\) videoRef\.current\?\.play\(\)/);
    expect(source).toContain("onFocus={() => setNear(true)}");
  });

  it("keeps the still under the clip until its first frame, so hover never flashes", () => {
    expect(card()).toMatch(/<img[^>]*poster\.jpg[^>]*>\s*<video/);
    expect(styles).toMatch(/\.theme-card-thumb video \{[^}]*opacity: 0;/);
    expect(styles).toContain(".theme-card-thumb video.ready {\n  opacity: 1;\n}");
  });

  it("holds the still under Reduce motion until the card is hovered or focused", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const html = card();
    expect(html).not.toContain("<video");
    expect(html).toContain('src="poster.jpg"');
  });
});

describe("error suggestion (3.3.3)", () => {
  it("speaks the kept scene length politely and shows nothing", () => {
    expect(keptLengthNote(4000)).toBe("Duration kept at 0:04.00");
    expect(renderToStaticMarkup(<KeptLengthNote note={keptLengthNote(2400)} />)).toBe(
      '<span class="visually-hidden" aria-live="polite">Duration kept at 0:02.40</span>',
    );
  });

  it("reverts every typed scene length quietly through the one note", () => {
    const fields: [string, RegExp][] = [
      [
        "./inspector/SceneTab.tsx",
        /if \(ms === null\) \{\s*setText\([^;]+;\s*kept\.keep\(durationMs\);/,
      ],
      ["./PlaybackBar.tsx", /if \(ms === null\) kept\.keep\(current\);/],
      [
        "./inspector/ScenesDrillIn.tsx",
        /if \(ms === null\) \{\s*if \(current\) kept\.keep\(current\.durationMs\);/,
      ],
      ["./TrackLane.tsx", /if \(ms === null\) kept\.keep\(durationMs\);/],
    ];
    for (const [path, revert] of fields) {
      const source = read(path);
      expect(source, path).toMatch(revert);
      expect(source, path).toContain("<KeptLengthNote note={kept.note} />");
      expect(source, path).toContain("kept.clear();");
      expect(source, path).not.toContain("Duration kept at");
    }
    const row = read("./inspector/SceneTab.tsx");
    const body = row.slice(row.indexOf("function DurationRow("), row.indexOf("function HingeRow("));
    expect(body).not.toMatch(/field-error|role="alert"|aria-invalid/);
  });

  it("says why a transition length reverted", () => {
    const picker = read("./TransitionPicker.tsx");
    expect(picker).toContain("setDurationInvalid(!valid);");
    expect(picker).toMatch(/role="alert">\s*Use 0\.1 to 2 seconds/);
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
