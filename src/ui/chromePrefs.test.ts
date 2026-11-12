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
    expect(emit).toHaveBeenCalledWith(prefs.CHROME_PREFS_EVENT);
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

  it("matches each Settings choice to a CSS scale", async () => {
    const { TEXT_SIZES } = await load();
    for (const size of TEXT_SIZES.filter((s) => s.id !== "default")) {
      expect(styles).toContain(
        `:root[data-text-size="${size.id}"] {\n  --text-scale: ${size.scale};\n}`,
      );
    }
  });

  it.each(["../styles.css", "../packs/packs.css"])(
    "leaves no fixed pixel font size in %s",
    (file) => {
      const fixed = read(file).match(/(font-size|line-height): \d+(\.\d+)?px/g);
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
  });
});
