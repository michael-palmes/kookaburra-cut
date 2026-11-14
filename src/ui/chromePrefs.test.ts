import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn(async () => {});
vi.mock("@tauri-apps/api/event", () => ({ emit, listen: vi.fn(async () => () => {}) }));

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
        readdirSync: (path: URL, options: { recursive: true }) => string[];
      };
    };
  }
).process;
const fs = testProcess.getBuiltinModule("fs");
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

let store: Map<string, string>;
let root: { dataset: Record<string, string> };

async function load(stored: Record<string, string> = {}) {
  store = new Map(Object.entries(stored));
  root = { dataset: {} };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
  vi.stubGlobal("document", { documentElement: root });
  vi.resetModules();
  const prefs = await import("./chromePrefs");
  prefs.installChromePrefs();
  return prefs;
}

const key = (k: string, extra: Record<string, unknown> = {}) => {
  const stopPropagation = vi.fn();
  return {
    event: {
      key: k,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target: { tagName: "BUTTON" },
      stopPropagation,
      ...extra,
    } as unknown as KeyboardEvent,
    stopPropagation,
  };
};

beforeEach(() => {
  emit.mockClear();
  vi.unstubAllGlobals();
});

describe("text size (1.4.4)", () => {
  it("starts at Default and leaves the root untouched", async () => {
    const prefs = await load();
    expect(prefs.getTextSize()).toBe("default");
    expect(root.dataset.textSize).toBeUndefined();
  });

  it("applies a stored size before first paint and ignores a stray value", async () => {
    expect((await load({ "kookaburra:text-size": "larger" })).getTextSize()).toBe("larger");
    expect(root.dataset.textSize).toBe("larger");
    expect((await load({ "kookaburra:text-size": "huge" })).getTextSize()).toBe("default");
  });

  it("persists a change, applies it at once and tells the other windows", async () => {
    const prefs = await load();
    prefs.setTextSize("large");
    expect(root.dataset.textSize).toBe("large");
    expect(store.get("kookaburra:text-size")).toBe("large");
    expect(emit).toHaveBeenCalledWith(prefs.CHROME_PREFS_EVENT, {
      textSize: "large",
      singleKey: true,
    });
    prefs.setTextSize("default");
    expect(root.dataset.textSize).toBeUndefined();
  });
});

describe("text size tokens", () => {
  const styles = read("../styles.css");

  it("scales every type, line-height and control-height token by --text-scale", () => {
    for (const name of [
      ...["2xs", "xs", "sm", "base", "md", "lg", "xl", "display"].flatMap((s) => [
        `text-${s}`,
        `lh-${s}`,
      ]),
      "control-h-sm",
      "control-h-md",
      "control-h-lg",
      "row-h-list",
      "titlebar-h",
    ]) {
      expect(styles, name).toMatch(
        new RegExp(`--${name}: calc\\(\\d+px \\* var\\(--text-scale\\)\\);`),
      );
    }
  });

  it("applies another window's change from the event, ahead of its storage write", async () => {
    const prefs = await load();
    prefs.applyChromePrefs({ textSize: "larger", singleKey: false });
    expect(root.dataset.textSize).toBe("larger");
    expect(prefs.singleKeyShortcutsEnabled()).toBe(false);
    prefs.applyChromePrefs({ textSize: "huge" as never });
    expect(prefs.getTextSize()).toBe("default");
    expect(store.size).toBe(0);
  });

  it("matches each Settings choice to a CSS scale", async () => {
    const { TEXT_SIZES } = await load();
    for (const size of TEXT_SIZES.filter((s) => s.id !== "default")) {
      expect(styles).toContain(
        `:root[data-text-size="${size.id}"] {\n  --text-scale: ${size.scale};\n}`,
      );
    }
  });

  it("reflows rather than clips at Larger", () => {
    const rule = (sel: string) =>
      styles.slice(styles.indexOf(`\n${sel} {`), styles.indexOf("}", styles.indexOf(`\n${sel} {`)));
    expect(rule(".modal-overlay")).toContain("overflow-y: auto;");
    expect(rule(".inspector")).toContain("width: calc(342px * var(--panel-scale));");
    expect(rule(".editor-window")).toContain("--chrome-top: calc(52px * var(--text-scale));");
    expect(styles).toMatch(
      /:root\[data-text-size\] :is\(\.template-card-tagline, \.theme-card-use-label\) \{\s*-webkit-line-clamp: unset;/,
    );
  });

  it("reflows at Largest: rails widen, crowded rows wrap or scroll, cut-off labels wrap", () => {
    const rule = (sel: string) =>
      styles.slice(styles.indexOf(`\n${sel} {`), styles.indexOf("}", styles.indexOf(`\n${sel} {`)));
    expect(styles).toContain("--panel-scale: calc(1 + (var(--text-scale) - 1) / 2);");
    expect(rule(".editor-toolbar")).toContain("flex-wrap: wrap;");
    expect(rule(".context-menu")).toContain("overflow-y: auto;");
    expect(rule(".load-notices")).toContain("overflow-y: auto;");
    expect(rule(".colour-popover")).toContain("width: calc(288px * var(--panel-scale));");
    expect(rule(".timeline-ruler")).toContain("height: calc(26px * var(--text-scale));");
    expect(rule(":root[data-text-size] .inspector-scene-overview")).toContain("overflow-y: auto;");
    expect(rule(":root[data-text-size] .theme-editor-body")).toContain("minmax(0, 1fr) 320px");
    const wrap = styles.slice(styles.indexOf("/* Enlarged text wraps labels"));
    for (const label of [
      ".project-card-name",
      ".theme-card-meta",
      ".template-card-name",
      ".settings-path",
    ]) {
      expect(wrap.slice(0, wrap.indexOf("}")), label).toContain(label);
    }
    expect(read("../packs/packs.css")).toContain("flex: 0 0 calc(208px * var(--panel-scale));");
    expect(rule(":root[data-text-size] .claude-launcher")).toContain("overflow-y: auto;");
    expect(rule(":root[data-text-size] .claude-launcher-menu")).toContain(
      "bottom: calc(100% + 6px);",
    );
    expect(rule(":root[data-text-size] .camera-pill")).toContain("width: auto;");
    expect(rule(".bg-sheet-slider")).toContain("height: calc(24px * var(--text-scale));");
    expect(wrap.slice(0, wrap.indexOf("}"))).toContain(".media-name");
  });

  it.each(["../styles.css", "../packs/packs.css"])(
    "leaves no fixed pixel font size in %s",
    (file) => {
      // SVG illustration text is in the drawing's own units, so it keeps fixed sizes.
      const css = read(file).replace(/\.claude-art \.c-[a-z]+ \{[^}]*\}/g, "");
      const fixed = css.match(/(font-size|line-height): \d+(\.\d+)?px/g);
      expect(fixed).toBeNull();
    },
  );
});

describe("never reaches an export", () => {
  it("keeps the export path and the render window clear of chrome preferences", () => {
    const engine = fs.readdirSync(new URL("../engine/", import.meta.url), { recursive: true });
    for (const file of engine.filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))) {
      expect(read(`../engine/${file}`), file).not.toMatch(/chromePrefs|text-scale/);
    }
    expect(read("../renderMain.tsx")).not.toContain("chromePrefs");
    expect(read("../presentMain.tsx")).not.toContain("chromePrefs");
  });
});

describe("single-key shortcuts (2.1.4)", () => {
  it("lets every key through while the switch is on", async () => {
    const prefs = await load();
    const { event, stopPropagation } = key("s");
    prefs.guardSingleKeyShortcuts(event);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("stops bare letters and symbols short of the window shortcuts once off", async () => {
    const prefs = await load({ "kookaburra:single-key-shortcuts": "0" });
    expect(prefs.singleKeyShortcutsEnabled()).toBe(false);
    for (const [k, extra] of [
      ["s", {}],
      ["S", { shiftKey: true }],
      ["/", {}],
      ["o", {}],
    ] as const) {
      const { event, stopPropagation } = key(k, extra);
      prefs.guardSingleKeyShortcuts(event);
      expect(stopPropagation, k).toHaveBeenCalled();
    }
  });

  it("keeps Space, arrows, modified keys and typing working when off", async () => {
    const prefs = await load({ "kookaburra:single-key-shortcuts": "0" });
    for (const { event, stopPropagation } of [
      key(" "),
      key("ArrowLeft"),
      key("Backspace"),
      key("k", { metaKey: true }),
      key("s", { altKey: true }),
      key("s", { target: { tagName: "INPUT" } }),
      key("s", { target: { tagName: "TEXTAREA" } }),
      key("s", { target: { tagName: "DIV", isContentEditable: true } }),
    ]) {
      prefs.guardSingleKeyShortcuts(event);
      expect(stopPropagation, event.key).not.toHaveBeenCalled();
    }
  });

  it("persists the switch and tells the other windows", async () => {
    const prefs = await load();
    prefs.setSingleKeyShortcuts(false);
    expect(store.get("kookaburra:single-key-shortcuts")).toBe("0");
    expect(prefs.singleKeyShortcutsEnabled()).toBe(false);
    expect(emit).toHaveBeenCalledWith(prefs.CHROME_PREFS_EVENT, {
      textSize: "default",
      singleKey: false,
    });
  });

  it("guards at document, below every window shortcut listener", () => {
    expect(read("./chromePrefs.ts")).toContain(
      'document.addEventListener("keydown", guardSingleKeyShortcuts);',
    );
  });
});
